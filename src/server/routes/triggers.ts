import { Hono } from 'hono';
import type { TriggerResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createPost } from '../core/post';
import { scoreContent } from '../mod/pipeline';
import { addSiqPostId, incrementReportAndMeta, isSiqPostId } from '../mod/store';
import type { ScoreContentRequest } from '../../shared/mod';

export const triggers = new Hono();

const toScorePayload = (
  body: Record<string, unknown>,
  reportCountOverride?: number
): ScoreContentRequest | null => {
  const post = typeof body.post === 'object' && body.post !== null ? (body.post as Record<string, unknown>) : null;
  const author =
    typeof body.author === 'object' && body.author !== null ? (body.author as Record<string, unknown>) : null;

  if (!post || typeof post.id !== 'string') {
    return null;
  }

  // Try multiple paths for author name
  const authorName =
    (typeof author?.name === 'string' ? author.name : null) ??
    (typeof (post as Record<string, unknown>).authorName === 'string' ? (post as Record<string, unknown>).authorName as string : null) ??
    (typeof (post as Record<string, unknown>).author === 'string' ? (post as Record<string, unknown>).author as string : null) ??
    'unknown';

  return {
    postId: post.id,
    title: typeof post.title === 'string' ? post.title : '(untitled)',
    body: typeof post.selftext === 'string' ? (post.selftext as string) : '',
    authorName,
    accountAgeDays: 0,
    karma: typeof author?.karma === 'number' ? author.karma : 0,
    reportCount:
      typeof reportCountOverride === 'number'
        ? reportCountOverride
        : (typeof post.numReports === 'number' ? post.numReports : 0),
    priorFlagsInSub: 0,
  };
};

triggers.post('/on-app-install', async () => {
  try {
    const post = await createPost();
    if (context.subredditId) {
      await addSiqPostId(context.subredditId, post.id);
    }
    return Response.json({
      status: 'success',
      message: `Post created in subreddit ${context.subredditName} with id ${post.id}`,
    } satisfies TriggerResponse);
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return Response.json({ status: 'error', message: 'Failed to create post' } satisfies TriggerResponse, {
      status: 400,
    });
  }
});

triggers.post('/on-post-create', async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const payload = toScorePayload(body);
    if (!payload || !context.subredditId) {
      return c.json<TriggerResponse>({ status: 'success', message: 'Skipped: missing post payload' });
    }

    const siq = await isSiqPostId(context.subredditId, payload.postId);
    if (siq) {
      return c.json<TriggerResponse>({ status: 'success', message: 'Skipped: SIQ dashboard post' });
    }
    
    await scoreContent(context.subredditId, payload);
    return c.json<TriggerResponse>({ status: 'success', message: 'Post scored and queued' });
  } catch (error) {
    console.error('on-post-create failed', error);
    return c.json<TriggerResponse>({ status: 'success', message: 'Post create trigger recovered from error' });
  }
});

triggers.post('/on-comment-create', async () => {
  return Response.json({ status: 'success', message: 'Comment event acknowledged' } satisfies TriggerResponse);
});

triggers.post('/on-post-report', async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (!context.subredditId) {
      return c.json<TriggerResponse>({ status: 'success', message: 'Skipped: missing subreddit context' });
    }

    const payload = toScorePayload(body);
    if (!payload) {
      return c.json<TriggerResponse>({ status: 'success', message: 'Skipped: missing post payload' });
    }

    const meta = await incrementReportAndMeta({
      subredditId: context.subredditId,
      postId: payload.postId,
      title: payload.title,
      authorName: payload.authorName,
    });

    // Note: Reddit's PostReport event does not expose the reporter's identity
    // (reports are anonymous to mods by Reddit platform design), so we do not
    // attempt to attribute reports to specific users here.

    if (meta.reportCount >= 3) {
      await scoreContent(context.subredditId, {
        ...payload,
        reportCount: meta.reportCount,
      });
    }

    return c.json<TriggerResponse>({ status: 'success', message: 'Report tracked' });
  } catch (error) {
    console.error('on-post-report failed', error);
    return c.json<TriggerResponse>({ status: 'success', message: 'Post report trigger recovered from error' });
  }
});
