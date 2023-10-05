import { kv } from '@vercel/kv'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { Configuration, OpenAIApi } from 'openai-edge'
import crypto from 'crypto';
import { AutoblocksTracer } from '@autoblocks/client';


import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})

const openai = new OpenAIApi(configuration)

export async function POST(req: Request) {
  const json = await req.json()
  
  const { messages, previewToken } = json
  const userId = (await auth())?.user.id
  if (!userId) {
    return new Response('Unauthorized', {
      status: 401
    })
  }

  if (previewToken) {
    configuration.apiKey = previewToken
  }

  // Traces
  const tracer = new AutoblocksTracer(
    process.env.AUTOBLOCKS_INGESTION_KEY || "", 
    { 
      traceId: crypto.randomUUID(),
      properties: {
        app: 'AI Chatbot',
        provider: 'openai'
      }
    }
  );

  // Simulation
  // const tracer = new AutoblocksTracer(
  //   process.env.AUTOBLOCKS_INGESTION_KEY || "", 
  //   { 
  //     traceId: "ai-chatbot-math",
  //     properties: {
  //       app: 'AI Chatbot',
  //       provider: 'openai'
  //     }
  //   }
  // );



  const systemMessage = {
    role: 'system',
    //content: ''
    //content: 'You are a math professor. Your goal is to answer math questions.'
    content: 'You are a math professor. Your goal is to answer math questions with as much precision and detail as possible. Use your extension mathematical experience to provide thorough, correct, and useful answers. Include proofs, equations, formulas, and any other mathematical tools as necessary. Break answers down into logical, easy to follow steps. Assume the user has only a basic understanding of math concepts.'
  }

  const completionProperties = {
    model: 'gpt-3.5-turbo',
    messages: [systemMessage, ...messages],
    temperature: 0.75,
  }

  const res = await openai.createChatCompletion({
    ...completionProperties,
    stream: true
  })

  await tracer.sendEvent('ai.request', {
    properties: completionProperties,
  });

  const stream = OpenAIStream(res, {
    async onCompletion(completion) {
      await tracer.sendEvent("ai.stream.completion", {
        properties: {
          completion
        }
      })
      const title = json.messages[0].content.substring(0, 100)
      const id = json.id ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...messages,
          {
            content: completion,
            role: 'assistant'
          }
        ]
      }
      await kv.hmset(`chat:${id}`, payload)
      await kv.zadd(`user:chat:${userId}`, {
        score: createdAt,
        member: `chat:${id}`
      })
    },
    async onStart(){
      await tracer.sendEvent("ai.stream.start", {properties: {}})
    }
  })

  return new StreamingTextResponse(stream)
}