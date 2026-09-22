import { GatewayError } from './errors.js';

type QuestionType = 'noul' | 'choice' | 'score';
export interface AskRequest {
  type: QuestionType;
  options?: string[];
  levels?: string[];
  payload: { state: unknown; model: string; questions: { result: Record<string, unknown> } };
}

function invalid(message: string): never {
  throw new GatewayError(400, 'invalid_request', message);
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseAsk(value: unknown, defaultModel: string): AskRequest {
  if (!record(value)) invalid('The request must be a JSON object.');
  const allowed = new Set(['state', 'question', 'type', 'options', 'levels', 'model']);
  if (Object.keys(value).some(key => !allowed.has(key))) invalid('Unknown request field.');
  if (value.state === null || !['string', 'object'].includes(typeof value.state)) {
    invalid('state must be a string, object or array.');
  }
  if (typeof value.question !== 'string' || !value.question.trim()) invalid('question must be a non-empty string.');
  const type = value.type === undefined ? 'noul' : value.type;
  if (!['noul', 'choice', 'score'].includes(type)) invalid('type must be noul, choice or score.');
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) {
    invalid('model must be a non-empty string.');
  }
  if (type !== 'choice' && 'options' in value) invalid('options is only valid for choice.');
  if (type !== 'score' && 'levels' in value) invalid('levels is only valid for score.');
  const question: Record<string, unknown> = { type, instructions: value.question };
  if (type === 'choice') {
    const options = value.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > 255 ||
        options.some(option => typeof option !== 'string' || !option.trim()) || new Set(options).size !== options.length) {
      invalid('options must contain 1 to 255 distinct non-empty strings.');
    }
    // Object.fromEntries 保留 __proto__ 等合法选项，不触发原型赋值。
    question.criteria = Object.fromEntries(options.map(option => [option, null]));
  }
  if (type === 'score') {
    const levels = value.levels;
    if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10 ||
        levels.some(level => typeof level !== 'string' || !level.trim())) {
      invalid('levels must contain 2 to 10 non-empty strings.');
    }
    question.criteria = levels;
  }
  return { type, options: value.options, levels: value.levels,
    payload: { state: value.state, model: value.model ?? defaultModel, questions: { result: question } } };
}

const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function simplifyAnswer(body: Buffer, request: AskRequest): Record<string, unknown> {
  const bad = () => new GatewayError(502, 'invalid_upstream_response', 'Jev returned an invalid or missing answer.');
  let answer: any;
  try { answer = JSON.parse(body.toString('utf8'))?.answers?.result; } catch { throw bad(); }
  if (!record(answer) || answer.type !== request.type) throw bad();
  if (request.type === 'noul') {
    if (!probability(answer.noul)) throw bad();
    return { value: answer.noul };
  }
  const keys = request.type === 'choice' ? request.options! : request.levels!.map((_, i) => String(i));
  if (!probability(answer.confidence) || !record(answer.probabilities) ||
      Object.keys(answer.probabilities).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(answer.probabilities, key) || !probability(answer.probabilities[key]))) {
    throw bad();
  }
  if (request.type === 'choice') {
    if (typeof answer.choice !== 'string' || !keys.includes(answer.choice)) throw bad();
    return { value: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities };
  }
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 ||
      answer.score > keys.length - 1 || !record(answer.legend) ||
      keys.some(key => typeof answer.legend[key] !== 'string')) throw bad();
  return { value: answer.score, confidence: answer.confidence, probabilities: answer.probabilities, legend: answer.legend };
}
