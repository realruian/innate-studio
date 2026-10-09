// 让文本模型写字的三个接口：润色提示词、按技能扩写、画布上的文本节点。

import { HttpError, readJsonBody, route } from '../http.js';
import { askTextModel, isTextModel } from '../ark.js';
import { findSkill } from './library.js';
import { polishGuide, POLISH_KINDS } from '../../shared/models.ts';

// 发给文本模型的系统提示词按要用的生成模型来选，规则都在 shared/models.ts。
route('POST', /^\/api\/polish$/, async ({ req }) => {
  // target 是这条提示词要拿去用的生成模型和生成方式。
  const { text, kind, model, target = {} } = await readJsonBody(req);
  const draft = String(text || '').trim();
  if (!draft) throw new HttpError(400, 'invalid_request', '请先输入提示词');
  if (draft.length > 4000) throw new HttpError(400, 'invalid_request', '提示词太长，润色最多支持 4000 字');
  if (!POLISH_KINDS.includes(kind)) throw new HttpError(400, 'invalid_request', '该类型不支持润色');
  const guide = polishGuide({ kind, model: target.model, mode: target.mode, refs: target.refs, duration: Number(target.duration) || undefined });
  if (!isTextModel(model)) throw new HttpError(400, 'invalid_request', '该模型不支持润色');
  return askTextModel(model, [{ role: 'system', content: guide }, { role: 'user', content: draft }], 1200);
});

// 按技能的规则把用户写的话扩写成提示词。context 是这次生成的设置（时长、有没有声音、带了几张参考图），原样放在用户那句话前面。
route('POST', /^\/api\/skills\/expand$/, async ({ req, space }) => {
  const { id, text, context, model } = await readJsonBody(req);
  const skill = findSkill(space, id);
  const draft = String(text || '').trim();
  if (!draft) throw new HttpError(400, 'invalid_request', '请先输入提示词');
  if (draft.length > 4000) throw new HttpError(400, 'invalid_request', '内容太长，技能最多处理 4000 字');
  if (!isTextModel(model)) throw new HttpError(400, 'invalid_request', '该模型不支持扩写');
  const setup = String(context || '').trim().slice(0, 500);
  return askTextModel(model, [{ role: 'system', content: skill.rules }, { role: 'user', content: setup ? `${setup}\n\n${draft}` : draft }], 2000);
});

// 画布上的文本节点让模型写一段文字：剧本、分镜、提示词都行。context 是连进来的文本和节点里已有的内容。
// 用的是和润色同一组文本模型，结果直接回到节点里，不进创作记录。
const WRITER_GUIDE = '你是影视和短视频创作的写作助手。按用户的要求写出内容本身：不要寒暄，不要解释你做了什么，不要用 Markdown 标题和加粗。用户给了参考内容时，在它的基础上写。用用户提要求时用的语言回答。';
route('POST', /^\/api\/text$/, async ({ req }) => {
  const { prompt, context, model } = await readJsonBody(req);
  const ask = String(prompt || '').trim();
  const given = String(context || '').trim();
  if (!ask) throw new HttpError(400, 'invalid_request', '请输入写作要求');
  if (ask.length + given.length > 12000) throw new HttpError(400, 'invalid_request', '内容太长，要求和参考内容加起来最多 12000 字');
  if (!isTextModel(model)) throw new HttpError(400, 'invalid_request', '该模型不支持文本生成');
  const user = given ? `参考内容：\n${given}\n\n要求：\n${ask}` : ask;
  return askTextModel(model, [{ role: 'system', content: WRITER_GUIDE }, { role: 'user', content: user }], 3000);
});
