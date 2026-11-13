// image-limit-v1 demo: verifies the newest-N image trimming used to avoid
// "Exceeded maximum number of images (50) allowed in the request".
// No network, no credentials. Run: node examples/image-limit.mjs
import { sanitizeResponsesRequest } from '../src-patched/sanitize.mjs';

let failed = 0;
const check = (name, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failed++;
};

const toolWithImage = (i) => ({
  type: 'custom_tool_call_output',
  call_id: `call_${i}`,
  output: [
    { type: 'input_text', text: `Script completed ${i}` },
    { type: 'input_image', image_url: `data:image/jpeg;base64,IMG${i}` },
  ],
});

const request = {
  model: 'gpt-6.1-sol',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ...Array.from({ length: 60 }, (_, i) => toolWithImage(i)),
  ],
};

const { body, stats } = sanitizeResponsesRequest(request, { maxImages: 30 });
const text = JSON.stringify(body);

check('60 images trimmed to 30', stats.images_removed === 30 && stats.images_kept === 30);
check('exactly 30 image blocks remain', (text.match(/input_image/g) || []).length === 30);
check('30 text placeholders added', (text.match(/older image omitted/g) || []).length === 30);
check('newest screenshot kept', text.includes('IMG59'));
check('oldest screenshot dropped', !text.includes('IMG0"'));
check('tool call pairing preserved', body.input.filter((i) => i.type === 'custom_tool_call_output').every((i) => i.call_id.startsWith('call_')));
check('caller input not mutated', request.input[1].output.length === 2);

const under = sanitizeResponsesRequest({ model: 'm', input: [toolWithImage(0), toolWithImage(1)] }, { maxImages: 30 });
check('under limit -> untouched', (under.stats.images_removed || 0) === 0);

const off = sanitizeResponsesRequest(request);
check('maxImages=0 disables trimming', (off.stats.images_removed || 0) === 0);

const messageImages = {
  model: 'm',
  input: [{
    type: 'message', role: 'user',
    content: [
      { type: 'input_text', text: 'see' },
      { type: 'input_image', image_url: 'data:img/1' },
      { type: 'input_image', image_url: 'data:img/2' },
      { type: 'input_image', image_url: 'data:img/3' },
    ],
  }],
};
const trimmed = sanitizeResponsesRequest(messageImages, { maxImages: 1 });
check('message images trimmed to newest one', (trimmed.stats.images_removed || 0) === 2
  && JSON.stringify(trimmed.body).includes('data:img/3')
  && !JSON.stringify(trimmed.body).includes('data:img/1'));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
