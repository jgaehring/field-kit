/* eslint-disable no-bitwise */

// Based on the JS implementation of Java's String.hashCode method, but w/o
// converting to int32, from https://stackoverflow.com/a/8831937/1549703.
function generateHash(str) {
  let hash = 0;
  if (str.length === 0) return hash;
  for (let i = 0; i < str.length; i += 1) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
  }
  return hash;
}

const hashPicker = (arr = []) => (str = '') => {
  const i = Math.abs(generateHash(str)) % arr.length;
  return arr[i];
};

export default hashPicker;
