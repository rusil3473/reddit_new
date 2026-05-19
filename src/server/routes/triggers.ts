import { Hono } from 'hono';
import type { TriggerResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createPost } from '../core/post';
import { ingestAndScore } from '../mod/pipeline';
import type { EnqueuePayload } from '../../shared/mod';

export const triggers = new Hono();

const mapTriggerToPayload = (
  body: Record<string, unknown>,
  contentKind: 'post' | 'comment',
  reportCount = 0
): EnqueuePayload | null => {
  const id = typeof body.id === 'string' ? body.id : null;
  const authorName = typeof body.authorName === 'string' ? body.authorName : 'unknown';
  const authorId = typeof body.authorId === 'string' ? body.authorId : authorName;
  const contentText = typeof body.body === 'string' ? body.body : typeof body.title === 'string' ? body.title : '';

  if (!id) {
    return null;
  }

  return {
    itemId: id,
    subredditId: context.subredditId ?? 'unknown_subreddit',
    subredditName: context.subredditName ?? 'unknown_subreddit',
    authorId,
    authorName,
    contentKind,
    contentText,
    permalink: typeof body.permalink === 'string' ? body.permalink : '',
    createdAt: Date.now(),
    reportCount,
  };
};

triggers.post('/on-app-install', async (c) => {
  try {
    const post = await createPost();
    return c.json<TriggerResponse>({
      status: 'success',
      message: `Post created in subreddit ${context.subredditName} with id ${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<TriggerResponse>({ status: 'error', message: 'Failed to create post' }, 400);
  }
});

triggers.post('/on-post-create', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const payload = mapTriggerToPayload(body, 'post');
  if (!payload) {
    return c.json<TriggerResponse>({ status: 'error', message: 'Missing post id' }, 400);
  }

  await ingestAndScore(payload);
  return c.json<TriggerResponse>({ status: 'success', message: 'Post scored and queued' });
});

triggers.post('/on-comment-create', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const payload = mapTriggerToPayload(body, 'comment');
  if (!payload) {
    return c.json<TriggerResponse>({ status: 'error', message: 'Missing comment id' }, 400);
  }

  await ingestAndScore(payload);
  return c.json<TriggerResponse>({ status: 'success', message: 'Comment scored and queued' });
});

triggers.post('/on-post-report', async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const count = typeof body.reportCount === 'number' ? body.reportCount : 1;
  const payload = mapTriggerToPayload(body, 'post', count);
  if (!payload) {
    return c.json<TriggerResponse>({ status: 'error', message: 'Missing report item id' }, 400);
  }

  await ingestAndScore(payload);
  return c.json<TriggerResponse>({ status: 'success', message: 'Reported item rescored' });
});
