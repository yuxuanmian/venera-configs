const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loadSource = (fileName, className, {data = {}, request} = {}) => {
  const sourceCode = fs.readFileSync(path.join(__dirname, '..', '..', fileName), 'utf8');
  class ComicSource {
    constructor() {
      this.data = {...data};
    }

    loadData(key) {
      return this.data[key];
    }

    loadSetting(key) {
      return this.data.settings && this.data.settings[key];
    }

    saveData(key, value) {
      this.data[key] = value;
      return 'ok';
    }

    deleteData(key) {
      delete this.data[key];
    }

    get isLogged() {
      return this.data.account != null;
    }
  }

  const calls = [];
  const context = {
    ComicSource,
    Convert: {
      encodeUtf8: (value) => value,
      hmacString: () => 'synthetic-signature',
    },
    createUuid: () => '00000000-0000-4000-8000-000000000000',
    Network: {
      get: async () => { throw new Error('scan tests must use injected request'); },
      post: async () => { throw new Error('scan tests must use injected request'); },
    },
    console,
    URL,
    Date,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(`${sourceCode}\nthis.__Source = ${className};`, context);
  const source = new context.__Source();
  source.data = {...data};
  const injectedRequest = request || (async (value) => {
    calls.push(value);
    return {status: 500, headers: {}, body: ''};
  });
  const requestWrapper = async (value) => {
    calls.push(value);
    return injectedRequest(value, calls);
  };
  return {source, calls, request: requestWrapper};
};

const picacgBody = ({id = 'comic-1', updatedAt = '2026-09-10T12:30:45.123Z'} = {}) =>
  JSON.stringify({data: {comic: {_id: id, updated_at: updatedAt}}});

const toPlain = (value) => JSON.parse(JSON.stringify(value));

const manwaBook = (id, {chapterId = `chapter-${id}`, isNew = false, fullIsNew = false} = {}) => ({
  id,
  book_name: `Fixture ${id}`,
  last_chapter: chapterId == null ? {} : {id: chapterId},
  is_new: isNew,
  full_is_new: fullIsNew,
});

module.exports = {loadSource, picacgBody, manwaBook, toPlain};
