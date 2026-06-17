// Local-dev entry shim. The production worker (index.js) re-exports a block of
// test-only symbols alongside its default handler; workerd's `wrangler dev`
// rejects non-handler named exports. This shim imports index.js (running all its
// module init) and re-exports ONLY the default fetch/scheduled handler, so a
// local worker boots for signet e2e runs against an un-rate-limited IP.
import handler from './index.js';
export default handler;
