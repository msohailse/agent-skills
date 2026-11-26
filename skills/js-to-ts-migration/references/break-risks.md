# What breaks in a JS to TS migration, and how to check

## Load order
Apps often do `require('dotenv').config()` and start an APM agent before anything else. ESM `import` statements are hoisted, so converting the entry file to `import` makes every module load before dotenv runs. Modules then read empty env, and the APM agent misses early modules. Stay CommonJS. If you ever move to ESM, keep env and APM setup in a separate entry file that loads first (`node -r ./preload.js`).
*Check:* the first lines of the entry file and `bin/` scripts are unchanged.

## Env read at module load
Top-level `const x = process.env.Y` is evaluated once, when the module loads. Reordering requires or lazy-loading changes the value it sees.
*Check:* `grep -rn "^\(const\|let\|var\) .*process\.env"` and keep those modules' load order.

## Cache and queue value shapes
Values in Memcached, Redis or a queue are read by other processes, sometimes other services. Changing a key name, a field name or the serialization (for example JSON vs gzip+JSON) while "cleaning up types" breaks the readers.
*Check:* list every cache and queue key and keep their names and payloads byte-compatible.

## Response shape drift
Other services depend on the exact JSON your routes return. Typing a response and dropping a field the type didn't declare, or turning a missing field into `null`, breaks them silently.
*Check:* before and after a controller conversion, diff real responses for its main routes against a test database.

## Test stubs keyed on paths
Hooks such as `Module._load`, proxyquire and `jest.mock('./x')` match on the resolved path. After a rename they stop matching and the real module loads, which can mean real network or database calls in tests.
*Check:* grep tests for the old filename in every conversion PR.

## Static assets and file reads
`fs.readFileSync(path.join(__dirname, 'spec.json'))` and `express.static(__dirname + '/public')` keep working with type stripping, because files stay where they are. They break with a `dist/` build unless you copy the assets.

## Circular requires
CommonJS cycles give a partially filled `module.exports` object. Destructuring at require time (`const { fn } = require('./a')`) captures `undefined` in a cycle.
*Check:* run a cycle detector (madge, or a small DFS over relative requires) before converting the files involved.

## ORM typings
Old ORM versions have weak or wrong types (Mongoose 5, for example). Typing models on them, then upgrading, is double work, and these versions often have security advisories anyway. Upgrade first, as its own tested PR.

## Monitoring
Stack traces in APM and error tools point at real line numbers with type stripping, since whitespace is preserved. With a `dist/` build you need source maps.

## Fallback: a dist/ build
Only if type stripping blocks something (old Node in production, or syntax you truly need): compile with `tsc` (`allowJs`, CommonJS output) to `dist/`, copy static assets, run `node dist/bin/www`, ship source maps, and update the Dockerfile and start command. Prove the build with zero `.ts` files first.
