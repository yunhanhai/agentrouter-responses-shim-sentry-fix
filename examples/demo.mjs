// sentry-fix-v1 unit demo: verifies nested encrypted_content removal,
// copy-on-write behavior, and regression of the original sanitizer logic.
// No network, no credentials. Run: node examples/demo.mjs
import { sanitizeResponsesRequest } from '../src-patched/sanitize.mjs';

let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failed++;
};

const request = {
  model: 'gpt-6.1-sol',
  input: [
    { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    {
      type: 'agent_message',
      id: 'amsg_1',
      author: '/root/agent-a',
      recipient: '/root',
      content: [
        { type: 'input_text', text: 'Message Type: MESSAGE\nPayload:\n' },
        { type: 'encrypted_content', encrypted_content: 'gAAAAABdemo_demo_demo' },
      ],
    },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAAAABreasoning_demo', summary: [] },
    {
      type: 'custom_tool_call_output',
      call_id: 'call_demo',
      output: [
        { type: 'input_text', text: 'ok' },
        { type: 'encrypted_content', encrypted_content: 'gAAAAABoutput_demo' },
      ],
    },
  ],
};

const { body, stats } = sanitizeResponsesRequest(request);

check('nested encrypted blocks removed (3)', stats.nested_encrypted_blocks_removed === 3);
check('reasoning item removed (original behavior)', stats.reasoning_items_removed === 1);
check('inline item ids removed (original behavior)', stats.item_ids_removed >= 1);
check('agent_message keeps its plaintext block', (() => {
  const item = body.input.find((i) => i.type === 'agent_message');
  return item && item.content.length === 1 && item.content[0].type === 'input_text';
})());
check('tool output keeps its plaintext block', (() => {
  const item = body.input.find((i) => i.type === 'custom_tool_call_output');
  return item && item.output.length === 1 && item.output[0].text === 'ok';
})());
check('no encrypted residue anywhere in output', !JSON.stringify(body).includes('gAAAAA'));
check('call_id pairing preserved', body.input.some((i) => i.call_id === 'call_demo'));
check('input object is not mutated (copy-on-write)', (() => {
  const item = request.input.find((i) => i.type === 'agent_message');
  return item.content.length === 2 && item.content[1].encrypted_content.startsWith('gAAAAA');
})());

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
