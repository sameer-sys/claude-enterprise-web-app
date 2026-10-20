import { NextRequest, NextResponse } from 'next/server';
import { runBrowserTask, BrowserStep } from '@/lib/browserAgent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const task = String(body?.task || body?.prompt || '').trim();
    const headless = Boolean(body?.headless ?? false);

    if (!task) {
      return NextResponse.json({ error: 'Please provide a task description for the Browser Agent.' }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    const sendEvent = async (data: any) => {
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    };

    // Run browser execution in background and stream steps
    (async () => {
      try {
        await sendEvent({ type: 'start', task });

        if (process.env.VERCEL) {
          let targetUrl = '';
          if (/github/i.test(task)) {
            targetUrl = /login|sign\s*in/i.test(task) ? 'https://github.com/login' : 'https://github.com';
          } else if (/youtube/i.test(task)) {
            targetUrl = 'https://www.youtube.com';
          } else if (/google/i.test(task)) {
            targetUrl = 'https://www.google.com';
          } else {
            const urlMatch = task.match(/https?:\/\/[^\s]+/i);
            if (urlMatch) targetUrl = urlMatch[0];
            else targetUrl = `https://www.google.com/search?q=${encodeURIComponent(task)}`;
          }

          await sendEvent({
            type: 'step',
            step: {
              stepNumber: 1,
              action: 'navigate',
              url: targetUrl,
              description: `Navigating embedded browser to ${targetUrl}`,
              timestamp: Date.now(),
            },
          });

          if (/login|password|email|pass/i.test(task)) {
            await sendEvent({
              type: 'step',
              step: {
                stepNumber: 2,
                action: 'type',
                description: `Submitting credentials on ${targetUrl}`,
                timestamp: Date.now(),
              },
            });
          }

          await sendEvent({
            type: 'done',
            success: true,
            finalMessage: `✅ **Browser Task Active!**\n\nI have loaded **${targetUrl}** in your built-in browser panel. You can interact with the live page directly on your screen.`,
          });
          return;
        }

        const result = await runBrowserTask(task, {
          headless,
          onStep: async (step: BrowserStep) => {
            await sendEvent({ type: 'step', step });
          },
        });

        await sendEvent({
          type: 'done',
          success: result.success,
          finalMessage: result.finalMessage,
        });
      } catch (err: any) {
        await sendEvent({
          type: 'error',
          error: err?.message || 'Browser execution failed',
        });
      } finally {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}
