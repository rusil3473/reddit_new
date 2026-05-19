import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, reddit } from '@devvit/web/server';

export const menu = new Hono();

menu.post('/post-create', async (c) => {
  try {
    const post = await reddit.submitCustomPost({
      title: 'Smart Intelligent Queue Dashboard',
    });

    return c.json<UiResponse>(
      {
        navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
      },
      200
    );
  } catch (error) {
    console.error(`Error creating dashboard post: ${error}`);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to create dashboard post',
      },
      400
    );
  }
});
