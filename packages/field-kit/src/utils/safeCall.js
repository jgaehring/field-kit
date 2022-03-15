// Utility for safely calling listeners and callbacks w/o worrying about exceptions.
const safeCall = (callback, ...args) => {
  try {
    callback(...args);
  } catch (error) {
    console.error(error); // eslint-disable-line no-console
  }
};

export default safeCall;
