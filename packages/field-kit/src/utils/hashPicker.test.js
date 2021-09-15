import hashPicker from './hashPicker';

describe('hashPicker', () => {
  it('Assigns colors to an array of log types', () => {
    const colors = ['purple', 'blue', 'green', 'yellow', 'orange', 'red'];
    const colorPicker = hashPicker(colors);
    const types = [
      'activity', 'harvest', 'input', 'maintenance', 'observation', 'seeding',
    ];
    expect(types.map(t => ({
      [t]: colorPicker(t),
    }))).toMatchObject([
      { activity: 'yellow' },
      { harvest: 'red' },
      { input: 'green' },
      { maintenance: 'red' },
      { observation: 'purple' },
      { seeding: 'yellow' },
    ]);
  });
});
