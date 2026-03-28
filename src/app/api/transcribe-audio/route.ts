import OpenAI from 'openai';
import { transcribeAudio } from '@/lib/llm';
import { NextResponse } from 'next/server';

const TRANSCRIPTION_PROMPT =
  'This is screen-share audio from a work meeting or presentation. Preserve names, product terms, acronyms, and action items accurately.';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    if (!file.size) {
      return NextResponse.json({ text: '' });
    }

    const normalizedFile = await OpenAI.toFile(
      Buffer.from(await file.arrayBuffer()),
      file.name || `meeting-audio-${Date.now()}.webm`,
      {
        type: file.type || 'audio/webm',
      }
    );

    const text = await transcribeAudio({
      file: normalizedFile,
      prompt: TRANSCRIPTION_PROMPT,
    });

    console.log(`transcribe-audio success: ${text.length} chars`);
    return NextResponse.json({ text });
  } catch (err) {
    console.error('transcribe-audio error:', err);
    const message = err instanceof Error ? err.message : 'Transcription failed';
    const isConfig = /API key|LLM configured|required for/i.test(message);
    const isQuota = /insufficient_quota|quota|billing details|429/i.test(message);
    const isBadAudio = /corrupted|unsupported|invalid file|400/i.test(message);
    return NextResponse.json(
      {
        error: isConfig || isQuota || isBadAudio ? message : 'Transcription failed',
      },
      { status: isQuota ? 429 : isBadAudio ? 400 : 500 }
    );
  }
}
