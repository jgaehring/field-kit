import {
  isProxy, isRef, reactive, readonly, ref, shallowReactive, unref, watch, watchEffect,
} from 'vue';
import {
  assoc, clone, complement, compose, curryN, equals, is,
  map, mapObjIndexed, pick, propEq, when,
} from 'ramda';
import { validate, v4 as uuidv4 } from 'uuid';
import { splitFilterByType } from 'farmos';
import farm from '../farm';
import router from '../router';
import { STATUS_IN_PROGRESS, updateStatus } from '../http/connection';
import interceptor from '../http/interceptor';
import { syncEntities } from '../http/sync';
import SyncScheduler from '../http/SyncScheduler';
import { getRecords } from '../idb';
import { cacheEntity } from '../idb/cache';
import asArray from '../utils/asArray';
import diff from '../utils/diff';
import parseFilter from '../utils/parseFilter';
import { PromiseQueue } from '../utils/promises';
import flattenEntity from '../utils/flattenEntity';
import safeCall from '../utils/safeCall';
import { alert } from '../warnings/alert';
import nomenclature from './nomenclature';
import {
  backupTransactions, clearBackup, restoreTransactions,
} from './backup';

// Constants for event names recognized by `on()`.
const EVENT_LOAD = 'load';
const EVENT_SYNC = 'sync';

const scheduler = new SyncScheduler();

// Emit takes the reactive state of an entity and updates its fields based on
// new data, thereby "emitting" those changes to any dependent components.
const emit = curryN(2, (state, data = {}) => {
  const {
    id, type, meta, attributes, relationships, ...rest
  } = data;
  const fields = { ...attributes, ...relationships, ...rest };
  Object.entries(fields).forEach(([key, val]) => {
    state[key] = val;
  });
  return data;
});

// For checking strict non-equivalence, including cyclical data structures, as
// a condition for applying a transaction.
const notEq = complement(equals);
// Flatten AND clone, for safe mutations within the replay scope.
const flatten = compose(clone, flattenEntity);

// Replay revision history based on the previous saved state and a series of
// atomic transactions. Only the changed fields are returned.
const replay = (previous, transactions) => {
  const fieldSet = new Set();
  const current = flatten(previous);
  transactions.forEach((tx) => {
    const txFields = tx(current);
    Object.entries(txFields).forEach(([key, value]) => {
      if (notEq(current[key], value)) {
        current[key] = value;
        fieldSet.add(key);
      }
    });
  });
  const fields = {};
  fieldSet.forEach((field) => {
    if (notEq(current[field], previous[field])) {
      fields[field] = current[field];
    }
  });
  return fields;
};

const syncHandler = revision => interceptor((evaluation) => {
  const {
    entity, type, id, state, listeners,
  } = revision;
  const {
    loginRequired, connectivity, repeatable, warnings, data: [value] = [],
  } = evaluation;
  updateStatus(connectivity);
  if (warnings.length > 0) {
    alert(warnings);
  }
  if (repeatable.length > 0) {
    const subscribe = scheduler.push(entity, type, id);
    subscribe((data) => {
      emit(state, data);
    });
  }
  if (loginRequired) {
    router.push('/login');
  }
  if (value) {
    emit(state, value);
    listeners.sync.forEach((fn) => { safeCall(fn, value); });
    cacheEntity(entity, value).catch(alert);
  }
});

function findRepeatableTypes(entity, errors) {
  const types = [];
  const bundleRE = /^\/api\/([a-z]*)\/([a-z]*)/;
  errors.forEach((error) => {
    const { config: { url }, request, response } = error;
    const [, e, b] = url.match(bundleRE);
    if (request && !response && b && e === entity) {
      const type = `${e}--${b}`;
      types.push(type);
    }
  });
  return types;
}

const collectionSyncHandler = (entity, filter, emitter) =>
  interceptor((evaluation) => {
    const {
      data, loginRequired, connectivity, repeatable, warnings,
    } = evaluation;
    data.forEach((value) => {
      emitter(value);
      cacheEntity(entity, value);
    });
    updateStatus(connectivity);
    if (warnings.length > 0) {
      alert(warnings);
    }
    const repeatableTypes = findRepeatableTypes(entity, repeatable);
    if (repeatableTypes.length > 0) {
      const repeatableFilters = splitFilterByType(filter, repeatableTypes);
      repeatableFilters.forEach(({ name: bundle, filter: bundleFilter }) => {
        const subscribe = scheduler.push(entity, bundle, bundleFilter);
        subscribe((results) => {
          results.data.forEach((value) => {
            emitter(value);
            cacheEntity(entity, value);
          });
        });
      });
    }
    if (loginRequired) {
      router.push('/login');
    }
  });

export default function useEntities(options = {}) {
  // A record of all revisions, each corresponding to a unique call of the
  // checkout function and mapped to the read-only ref returned by that call.
  const revisions = new WeakMap();
  // For tracking collections of entities, which in turn have their own revisions
  // tracked individually above. This is primarily for appending new items to
  // the collection, but may be useful for attaching listeners in the future.
  const collections = new WeakMap();
  // A store of Vue watch/unwatch callbacks, used when linking an entity or
  // collection of entities to another entity's reactive state.
  const linkWatchers = new WeakMap();

  const { module: modConfig } = options;

  function identifyRoute() {
    const current = router.currentRoute.value;
    if (current.path !== '/home' || !is(Object, modConfig)) return current;
    // If useEntities being called from the '/home' route it's a module widget.
    // In this case, identify the module, then find its top-level route record.
    const { routes: [record = {}] = [] } = modConfig;
    if (!record.path) return current;
    return router.resolve(record.path);
  }

  // Create a reference to a new entity. Just for internal use.
  function createEntity(entity, type, id) {
    const { shortName } = nomenclature.entities[entity];
    const _id = validate(id) ? id : uuidv4();
    const init = farm[shortName].create({ id: _id, type });
    const defaultFields = {
      id: _id, type, ...init.attributes, ...init.relationships,
    };
    const state = reactive(defaultFields);
    const reference = readonly(state);
    const queue = new PromiseQueue();
    queue.push(() => init);
    const route = identifyRoute();
    const [backupURI, transactions] = restoreTransactions(entity, type, _id, route);
    const listeners = { load: new Set(), sync: new Set() };
    const revision = {
      entity, type, id: _id, state, transactions, queue, backupURI, listeners,
    };
    revisions.set(reference, revision);
    return [reference, revision];
  }

  // Create a reference to a single entity without yet committing it.
  function add(entity, type, fields = {}) {
    const [reference, revision] = createEntity(entity, type, fields?.id);
    const { queue, state: itemState } = revision;
    const { shortName } = nomenclature.entities[entity];
    queue.push((prev) => {
      const next = farm[shortName].update(prev, fields);
      emit(itemState, next);
      return next;
    });
    return reference;
  }

  // Create a new entity and add it to an existing collection.
  function append(collectionReference, type, fields) {
    const collection = collections.get(collectionReference);
    const { entity, state: collectionState } = collection;
    const itemReference = add(entity, type, fields);
    collectionState.push(itemReference);
    return itemReference;
  }

  // Remove an entity from a collection of entities. This discards any pending
  // revisions, but does not delete the entity from local or remote persistence.
  function drop(collectionReference, id) {
    const collection = collections.get(collectionReference);
    const { state: collectionState } = collection;
    const i = collectionState.findIndex(item => item.id === id);
    const itemRef = collectionReference[i];
    collectionState.splice(i, 1);
    return itemRef;
  }

  // Upsert an entity in the collection.
  const emitCollection = reference => (value = {}) => {
    const { id, type, ...fields } = value;
    const { state } = collections.get(reference);
    if (typeof id !== 'string' || typeof type !== 'string') return;
    const i = state.findIndex(item => item.id === id);
    if (i < 0) {
      append(reference, type, value);
    } else {
      const itemRef = state[i];
      const { state: itemState } = revisions.get(itemRef);
      emit(itemState, fields);
    }
  };

  // A synchronous operation that returns a read-only, reactive array of entity
  // references, then updates those entities as new data comes in. When the
  // checkout function gets a filter instead of a type or id, it dispatches to
  // checkoutCollection internally, so this is not exposed publicly.
  function checkoutCollection(entity, filter) {
    const state = shallowReactive([]);
    const reference = readonly(state);
    const listeners = { load: new Set(), sync: new Set() };
    const collection = {
      entity, filter, state, listeners,
    };
    collections.set(reference, collection);
    const query = parseFilter(filter);
    updateStatus(STATUS_IN_PROGRESS);
    const { shortName } = nomenclature.entities[entity];
    getRecords('entities', entity, query).then((cache) => {
      cache.forEach(emitCollection(reference));
      const syncOptions = { cache, filter };
      return syncEntities(shortName, syncOptions);
    }).then(collectionSyncHandler(entity, filter, emitCollection(reference)))
      .then((results) => {
        listeners.sync.forEach((fn) => { fn(results.data); });
        state.forEach((itemRef) => {
          const { state: itemState, transactions } = revisions.get(itemRef);
          const fields = replay(itemState, transactions);
          emit(itemState, fields);
        });
      });
    return reference;
  }

  // A synchronous operation that immediately returns a read-only, reactive
  // reference to an entity, then updates that reference as new data comes in,
  // first from the local database, then from any remote systems.
  function checkout(entity, type, id) {
    const _entity = nomenclature.memoized[entity];
    if (!_entity) throw new Error(`Checkout failed; invalid entity name: ${entity}`);
    const { shortName } = nomenclature.entities[_entity];
    // Dispatch to checkoutCollection if the 2nd or 3rd param is a filter object.
    if (is(Object, type)) return checkoutCollection(_entity, type);
    if (is(Object, id)) {
      const filter = typeof type === 'string' ? { ...id, type } : id;
      return checkoutCollection(_entity, filter);
    }
    const [reference, revision] = createEntity(_entity, type, id);
    // Early return if this is a brand new entity.
    if (!validate(id)) return reference;
    const {
      queue, state, transactions, listeners,
    } = revision;
    queue.push(() => {
      updateStatus(STATUS_IN_PROGRESS);
      return getRecords('entities', _entity, id).then((data) => {
        if (data) {
          emit(state, data);
          listeners.load.forEach((fn) => { safeCall(fn, data); });
        }
        const syncOptions = { cache: asArray(data), filter: { id, type } };
        return syncEntities(shortName, syncOptions)
          .then(syncHandler(revision))
          .then(({ data: [value] = [] } = {}) => {
            const fields = replay(value, transactions);
            emit(state, fields);
            if (value) listeners.sync.forEach((fn) => { fn(value); });
            return value;
          });
      });
    });
    return reference;
  }

  function on(reference, event, handler) {
    if ([EVENT_LOAD, EVENT_SYNC].includes(event)) {
      let listeners = {};
      if (revisions.has(reference)) ({ listeners } = revisions.get(reference));
      if (collections.has(reference)) ({ listeners } = collections.get(reference));
      listeners[event]?.add(handler);
      return () => listeners[event]?.delete(handler);
    }
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('Invalid entity event: ', event);
    }
    return () => false;
  }

  // A synchronous operation that updates the reference but does not persist
  // that update in the local database or send it to any remote. Instead, it
  // holds onto the transaction so it can be replayed by the commit function.
  function revise(reference, transaction) {
    let fields = {}; let tx = () => fields;
    if (typeof transaction === 'function') tx = transaction;
    if (is(Object, transaction)) fields = transaction;
    const { state, transactions, backupURI } = revisions.get(reference);
    fields = tx(reference);
    transactions.push(tx);
    backupTransactions(backupURI, fields);
    emit(state, fields);
  }

  // Checkout the entity or a collection of entities related to another that's
  // already been checked out (ie, `referent`). The linked reference will
  // be updated reactively if a resource identifier changes in the corresponding
  // relationship field of the original referent.
  function link(referent, relationship, entity) {
    if (!isProxy(referent) && !isRef(referent)) {
      const msg = `Invalid referent while linking the ${relationship} relationship.`
        + ' Provide a reference to another entity that has already been checked out,'
        + ' or use valid Vue ref or reactive object as a placeholder.';
      throw new Error(msg);
    }
    const state = ref(null);
    const linkedRef = readonly(state);
    revisions.set(linkedRef, { entity, state });
    // This callback is a Vue watcher set on the original reference, or more
    // specifically, on a getter for the particular relationship field on that
    // origRef. When called, it updates the state of the linkedRef accordingly.
    const update = (next, prev) => {
      const origRef = revisions.has(referent) ? referent : unref(referent);
      const origRev = revisions.get(origRef);
      if (!is(Map, origRev.dependencies)) origRev.dependencies = new Map();
      if (!next && validate(prev?.id)) {
        origRev.dependencies.delete(state.value);
        state.value = null;
      }
      if (validate(next?.id) && next.id !== prev?.id) {
        origRev.dependencies.delete(state.value);
        state.value = checkout(entity, next.type, prev.id);
        origRev.dependencies.set(state.value, relationship);
        // After setting the state, "unwrap" the new revision data too, by swapping
        // it for all but the previous revision's state and unwatch callback, then
        // setting it to the linked reference. This obviates the need to unwrap the
        // value in every subsequent calls to `revise`, `append`, etc.
        const revision = revisions.get(state.value);
        revisions.set(linkedRef, revision);
      }
      if ([origRef?.[relationship], state.value, next].some(Array.isArray)) {
        if (!collections.has(state.value)) {
          const filter = map(pick(['id', 'type']), next || []);
          const nextRef = checkoutCollection(entity, filter);
          state.value = nextRef;
          const collection = collections.get(nextRef);
          collections.set(state.value, collection);
        }
        const [additions, removals, indices] = diff((p, n) => p.id === n.id, prev, next);
        removals.forEach((r) => {
          // When the previous id was null or invalid, there's nothing to drop.
          if (validate(r.id)) {
            const droppedRef = drop(state.value, r.id);
            origRev.dependencies.delete(droppedRef);
          }
        });
        const nullIndices = [];
        additions.forEach((a, j) => {
          if (validate(a.id)) {
            const appendedRef = append(state.value, a.type, a);
            origRev.dependencies.set(appendedRef, relationship);
          } else {
            const i = indices[j];
            nullIndices.push(i);
          }
        });
        // When a null or invalid id is provided, the id must be set manually on
        // the original referent, without appending. That will trigger update to
        // be called again, and on the second try it WILL validate and the ref
        // will be appended once and only once. Otherwise, trying to append AND
        // set the original referent's state in the same call would result in a
        // double append.
        if (nullIndices.length > 0) {
          const withIds = next.map((n, i) => {
            if (!nullIndices.includes(i)) return n;
            return { ...n, id: uuidv4() };
          });
          revise(origRef, { [relationship]: withIds });
        }
      }
    };
    // To make sure the linkedRef gets updates whenever there are changes to the
    // corresponding resource identifiers in the origRef, a watcher must be set.
    let watcherIsSet = false;
    const setLinkWatcher = () => {
      const origRef = revisions.has(referent) ? referent : unref(referent);
      // The original ref might be null or undefined initially, so check first.
      if (revisions.has(origRef) && relationship in origRef && !watcherIsSet) {
        const getter = () => origRef[relationship];
        linkWatchers.set(linkedRef, {
          watch: update,
          unwatch: watch(getter, update, { deep: true }),
        });
        update(origRef[relationship]);
        watcherIsSet = true;
      }
    };
    setLinkWatcher();
    // If the watcher can't be set right away, use watchEffect with the setter
    // as a callback, to watch all changes to the original ref as a whole.
    if (!watcherIsSet) watchEffect(setLinkWatcher);
    return linkedRef;
  }

  // Manually break the link between the original reference and the reference to
  // its related entity or entities, via Vue's `unwatch` handler:
  // https://vuejs.org/guide/essentials/watchers.html#stopping-a-watcher
  function unlink(reference) {
    const watcher = linkWatchers.get(reference);
    if (watcher && typeof watcher.unwatch === 'function') watcher.unwatch();
  }

  // An ASYNCHRONOUS operation, which replays all transactions based on the
  // current state of the entity at the time of calling, then writes those
  // changes to the local database and sends them on to remote systems.
  function commit(reference) {
    if (is(Array, reference) || is(Array, unref(reference))) {
      const allCommits = reference?.map(commit) || unref(reference).map(commit);
      return Promise.allSettled(allCommits);
    }
    const revision = revisions.get(reference) || revisions.get(unref(reference));
    const transactions = [...revision.transactions];
    revision.transactions = [];
    const {
      entity, type, id, queue, state, backupURI, dependencies, listeners,
    } = revision;
    const { shortName } = nomenclature.entities[entity];
    return queue.push((previous) => {
      updateStatus(STATUS_IN_PROGRESS);
      const fields = replay(previous, transactions);
      // The state will have had these transactions applied already, but may not
      // have received updates from a previous commit, so make sure to update it.
      emit(state, fields);
      const next = farm[shortName].update(previous, fields);
      return cacheEntity(entity, next)
        .then(() => {
          clearBackup(backupURI);
          if (!is(Map, dependencies)) return Promise.resolve({});
          // Dependent fields, created as relationships by the link function above,
          // must have their corresponding entities committed first.
          const dependentCommits = Array.from(dependencies)
            .filter(([, relationship]) => relationship in fields)
            .map(([depRef, relationship]) => commit(depRef)
              // Key each response to its original relationship, so it can be
              // mapped to its corresponding field, updating it in the process.
              .then(response => [relationship, response]));
          // Then Promise.all will resolve to an array of key/val pairs, which
          // can be transformed to an object for easier mapping below.
          return Promise.all(dependentCommits)
            .then(Object.fromEntries);
        })
        .then(mapObjIndexed((response, relationship) => {
          // Most dependent fields, especially quantities, require the revision
          // metadata be included in the relationship field, so those internal
          // Drupal attributes must be mapped to their corresponding resource
          // identifiers in the entity being committed here. Oy vey.
          const {
            drupal_internal__revision_id: target_revision_id,
            drupal_internal__id: drupal_internal__target_id,
          } = response.meta?.remote?.meta?.attributes || {};
          if (!drupal_internal__target_id) return fields[relationship];
          const meta = { target_revision_id, drupal_internal__target_id };
          // Add metadata to a single resource identifier.
          const addMetaData = assoc('meta', meta);
          // Add metadata to a resource identifier in a one-to-many relationship.
          const insertMetaData = map(when(propEq('id', response.id), addMetaData));
          return Array.isArray(fields[relationship])
            ? insertMetaData(fields[relationship]) // one-to-many
            : addMetaData(fields[relationship]); // one-to-one
        }))
        .then((finalFields) => {
          // Early return for an empty fields object.
          if (Object.keys(finalFields).length === 0) return next;
          // Emit and update one last time with those fields and their metadata.
          emit(state, finalFields);
          return farm[shortName].update(next, finalFields);
        })
        .then((final) => {
          const syncOptions = { cache: asArray(final), filter: { id, type } };
          return syncEntities(shortName, syncOptions);
        })
        .then(syncHandler(revision))
        .then(({ data: [value] = [] } = {}) => {
          if (value) listeners.sync.forEach((fn) => { fn(value); });
          return value;
        });
    });
  }

  return {
    add, append, checkout, commit, drop, link, on, revise, unlink,
  };
}
