import { NextRequest, NextResponse } from 'next/server';
import { runBrowserTask, BrowserStep } from '@/lib/browserAgent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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

        const result = await runBrowserTask(task, {
          headless: process.env.VERCEL ? true : headless,
          geminiApiKey: process.env.GEMINI_API_KEY,
          groqApiKey: process.env.GROQ_API_KEY,
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
