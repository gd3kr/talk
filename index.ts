import { spawn } from 'child_process';
import readline from 'readline';
import config from './config.json';
const { whisperModelPath, audioListenerScript } = config;
import { talk } from './src/talk';
const fs = require('fs');
const path = require('path');

const whisper = require('./bindings/whisper/whisper-addon');
// INIT GGML CPP BINDINGS
whisper.init(whisperModelPath);

let globalWhisperPromise: Promise<string>;

// CONSTANTS
const SAMPLING_RATE = 16000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const ONE_SECOND = SAMPLING_RATE * (BIT_DEPTH / 8) * CHANNELS;
const BUFFER_LENGTH_SECONDS = 28;
const BUFFER_LENGTH_MS = BUFFER_LENGTH_SECONDS * 1000;
const DEFAULT_LLAMA_SERVER_URL = 'http://127.0.0.1:8080'

let llamaServerUrl: string = DEFAULT_LLAMA_SERVER_URL;

if ('llamaServerUrl' in config) {
  llamaServerUrl = config.llamaServerUrl as string;
}

const DEFAULT_PROMPT = "Continue the dialogue, speak for bob only. \nMake it a fun lighthearted conversation."

let conversationPrompt: string = DEFAULT_PROMPT;
let personaConfig: string = "";
if ('personaFile' in config) {
  const personaFilePath = path.resolve(config.personaFile);
  if (fs.existsSync(personaFilePath)) {
    personaConfig = fs.readFileSync(personaFilePath, 'utf8');
    conversationPrompt = "";
  }
}


// INTERFACES
type EventType = 'audioBytes' | 'responseReflex' | 'transcription' | 'cutTranscription' | 'talk';
interface Event {
  eventType: EventType;
  timestamp: number;
  data: { [key: string]: any };
}
interface AudioBytesEvent extends Event {
  eventType: 'audioBytes';
  data: {
    buffer: Buffer;
  }
}
interface ResponseReflexEvent extends Event {
  eventType: 'responseReflex';
  data: {
    transcription: string
  }
}
interface TranscriptionEvent extends Event {
  eventType: 'transcription';
  data: {
    buffer: Buffer;
    transcription: string;
    lastAudioByteEventTimestamp: number;
  }
}
interface CutTranscriptionEvent extends Event {
  eventType: 'cutTranscription';
  data: {
    buffer: Buffer;
    transcription: string;
    lastAudioByteEventTimestamp: number;
  }
}
interface TalkEvent extends Event {
  eventType: 'talk';
  data: {
    response: string;
  }
}
interface EventLog {
  events: Event[];
}
const eventlog: EventLog = {
  events: []
};

class PrintBuffer {
  // holds the current transcription and current conversation and prints them to the consoleq

  transcription: string = "";
  conversation: string = "";

  constructor() {
    setInterval(() => {
      console.clear();
      // console.log in green
      console.log('\x1b[32m%s\x1b[0m', this.conversation);

      console.log("\n");
      // console.log in yellow
      console.log('\x1b[33m%s\x1b[0m', this.transcription);
    }, 100);
  }

}

// EVENTLOG UTILITY FUNCTIONS
// From the event log, get the transcription so far
const getLastTranscriptionEvent = (): TranscriptionEvent => {
  const transcriptionEvents = eventlog.events.filter(e => e.eventType === 'transcription');
  return transcriptionEvents[transcriptionEvents.length - 1] as TranscriptionEvent;
}

const getLastResponseReflexTimestamp = (): number => {
  const responseReflexEvents = eventlog.events.filter(e => e.eventType === 'responseReflex');
  return responseReflexEvents.length > 0 ? responseReflexEvents[responseReflexEvents.length - 1].timestamp : eventlog.events[0].timestamp;
};

const getCutTimestamp = (): number => {
  const cutTranscriptionEvents = eventlog.events.filter(e => e.eventType === 'cutTranscription');
  const lastCut = cutTranscriptionEvents.length > 0 ? cutTranscriptionEvents[cutTranscriptionEvents.length - 1].data.lastAudioByteEventTimestamp : eventlog.events[0].timestamp;
  const lastResponseReflex = getLastResponseReflexTimestamp();
  return Math.max(lastResponseReflex, lastCut);
}

const getTransciptionSoFar = (): string => {
  const lastResponseReflex = getLastResponseReflexTimestamp();
  const cutTranscriptionEvents = eventlog.events.filter(e => e.eventType === 'cutTranscription' && e.timestamp > lastResponseReflex);
  const lastTranscriptionEvent = getLastTranscriptionEvent();
  const lastCutTranscriptionEvent = cutTranscriptionEvents[cutTranscriptionEvents.length - 1];
  let transcription = cutTranscriptionEvents.map(e => e.data.transcription).join(' ');
  if (!lastCutTranscriptionEvent || lastCutTranscriptionEvent.timestamp !== lastTranscriptionEvent.timestamp) {
    transcription = transcription + (lastTranscriptionEvent?.data?.transcription || '')
  }
  return transcription
}

const getDialogue = (): string => {
  const dialogueEvents = eventlog.events
    .filter(e => e.eventType === 'responseReflex' || e.eventType === 'talk');

  let result = [];
  let lastType = null;
  let mergedText = '';

  for (let e of dialogueEvents) {
    const currentSpeaker = e.eventType === 'responseReflex' ? 'alice' : 'bob';
    const currentText = e.eventType === 'responseReflex' ? e.data.transcription : e.data.response;

    if (lastType && lastType === currentSpeaker) {
      mergedText += ' ' + currentText;
    } else {
      if (mergedText) result.push(mergedText);
      mergedText = `${currentSpeaker}: ${currentText}`;
    }

    lastType = currentSpeaker;
  }

  // push last merged text
  if (mergedText) result.push(mergedText);

  return result.join('\n');
}

// const updateScreenEvents: Set<EventType> = new Set([])
const updateScreenEvents: Set<EventType> = new Set(['responseReflex', 'cutTranscription', 'talk', 'transcription'])

let lastDialogue = "";
const updateScreen = (event: Event) => {
  if (updateScreenEvents.has(event.eventType)) {

    const currentDialogue = getDialogue();

    if (currentDialogue && currentDialogue !== lastDialogue) {
      printBuffer.conversation = currentDialogue;
    }

    lastDialogue = currentDialogue;
  }
}

// EVENTS
const newEventHandler = (event: Event): void => {
  eventlog.events.push(event);
  updateScreen(event)
  const downstreamEvents = eventDag[event.eventType];
  for (const downstreamEvent in downstreamEvents) {
    const downstreamEventFn = downstreamEvents[downstreamEvent as EventType];
    // Note: Unecessary existence check, this is typesafe
    if (downstreamEventFn) {
      downstreamEventFn(event);
    }
  }
}

const newAudioBytesEvent = (buffer: Buffer): void => {
  const audioBytesEvent: AudioBytesEvent = {
    timestamp: Number(Date.now()),
    eventType: 'audioBytes',
    data: { buffer }
  }
  newEventHandler(audioBytesEvent);
}

let transcriptionMutex = false;
const transcriptionEventHandler = async (event: AudioBytesEvent) => {
  // TODO: Unbounded linear growth. Instead, walk backwards or something.
  const lastCut = getCutTimestamp();
  const audioBytesEvents = eventlog.events.filter(e => e.eventType === 'audioBytes' && e.timestamp >= lastCut);
  const joinedBuffer = Buffer.concat(
    audioBytesEvents.map((event) => event.data.buffer)
  );

  // TODO: Wait for 1s, because whisper bindings currently throw out if not enough audio passed in
  // Therefore fix whisper
  if (!transcriptionMutex && joinedBuffer.length > ONE_SECOND) {
    transcriptionMutex = true;
    globalWhisperPromise = whisper.whisperInferenceOnBytes(joinedBuffer);
    const rawTranscription = await globalWhisperPromise;
    // Remove transcription artifacts like (wind howling)
    const transcription = rawTranscription.replace(/\s*\[[^\]]*\]\s*|\s*\([^)]*\)\s*/g, '');
    const transcriptionEvent: TranscriptionEvent = {
      timestamp: Number(Date.now()),
      eventType: 'transcription',
      data: {
        buffer: joinedBuffer,
        transcription,
        lastAudioByteEventTimestamp: audioBytesEvents[audioBytesEvents.length - 1].timestamp
      }
    }
    newEventHandler(transcriptionEvent);
    transcriptionMutex = false;
  }
}

const cutTranscriptionEventHandler = async (event: TranscriptionEvent) => {
  const lastCut = getCutTimestamp();
  const timeDiff = event.timestamp - lastCut;
  if (timeDiff > BUFFER_LENGTH_MS) {
    const cutTranscriptionEvent: CutTranscriptionEvent = {
      timestamp: event.timestamp,
      eventType: 'cutTranscription',
      data: {
        buffer: event.data.buffer,
        transcription: event.data.transcription,
        lastAudioByteEventTimestamp: event.data.lastAudioByteEventTimestamp
      }
    }
    newEventHandler(cutTranscriptionEvent);
  }
}

const responseReflexEventHandler = async (): Promise<void> => {
  await globalWhisperPromise;
  const responseReflexEvent: ResponseReflexEvent = {
    timestamp: Number(Date.now()),
    eventType: 'responseReflex',
    data: {
      transcription: getTransciptionSoFar()
    }
  }
  newEventHandler(responseReflexEvent);
}

const talkEventHandler = (event: ResponseReflexEvent): void => {
  const talkCallback = (sentence: string) => {
    const talkEvent: TalkEvent = {
      timestamp: Number(Date.now()),
      eventType: 'talk',
      data: {
        response: sentence.trim()
      }
    }
    newEventHandler(talkEvent);
  };
  const input = getDialogue();
  talk(
    conversationPrompt,
    input,
    llamaServerUrl,
    personaConfig,
    talkCallback
  );
}

// Defines the DAG through which events trigger each other
// Implicitly used by newEventHandler to spawn the correct downstream event handler
// All event spawners call newEventHandler
// newEventHandler adds the new event to event log
// This is actually not great. Might just have it be implicit.
const eventDag: { [key in EventType]: { [key in EventType]?: (event: any) => void } } = {
  audioBytes: {
    transcription: transcriptionEventHandler,
  },
  responseReflex: {
    talk: talkEventHandler,
  },
  transcription: {
    cutTranscription: cutTranscriptionEventHandler,
  },
  cutTranscription: {},
  talk: {},
}

const audioProcess = spawn('bash', [audioListenerScript]);
audioProcess.stdout.on('readable', () => {
  let data;
  while (data = audioProcess.stdout.read()) {
    newAudioBytesEvent(data);
  }
});

readline.emitKeypressEvents(process.stdin);


let lastTranscription = "";
let printBuffer = new PrintBuffer(); 

// should be a better way to do this
setInterval(() => {
  try{
    const currentTranscription = getTransciptionSoFar();
      if (currentTranscription !== lastTranscription){
      printBuffer.transcription = currentTranscription
      lastTranscription = currentTranscription;
    }
  }
  catch(err){
    // no transcription yet
    return;
  }
}, 100);
process.stdin.setRawMode(true);
process.stdin.on('keypress', async (str, key) => {
  // Detect Ctrl+C and manually emit SIGINT to preserve default behavior
  if (key.sequence === '\u0003') {
    await Promise.all([globalWhisperPromise]);
    process.exit();
  }

  // R for respond
  if (key.sequence === 'r') {
    responseReflexEventHandler();
  }
});
