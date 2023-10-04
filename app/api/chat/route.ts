import { kv } from '@vercel/kv'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { Configuration, OpenAIApi } from 'openai-edge'


import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

export const runtime = 'edge'

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

  const completionProperties = {
    model: 'gpt-3.5-turbo',
    messages,
    temperature: 0.7,
  }
  const res = await openai.createChatCompletion({
    ...completionProperties,
    stream: true
  })

  const traceId = await createTracer("ai.request", completionProperties)

  const stream = OpenAIStream(res, {
    async onCompletion(completion) {
      await sendEvent("ai.stream.completion", { completion }, traceId)
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
      await sendEvent("ai.stream.start", {  }, traceId)
    }
  })

  return new StreamingTextResponse(stream)
}

const createTracer = async(message: string, properties: object)=>{
  try {
    const res = await fetch('https://ingest-event.autoblocks.ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.AUTOBLOCKS_INGESTION_KEY || ''}`,
      },
      body: JSON.stringify({
        message,
        properties,
      }),
    });
    const data = await res.json()
    return data.traceId
  } catch {
    console.log("Failed to create tracer.")
    return ""
  }
}
const sendEvent = async (message: string, properties: object, traceId: string)=>{
  try {
    const res = await fetch('https://ingest-event.autoblocks.ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.AUTOBLOCKS_INGESTION_KEY || ''}`,
      },
      body: JSON.stringify({
        message,
        properties,
        traceId
      }),
    });
    return await res.json();
  } catch {
    console.log("Failed to send event to Autoblocks.")
    return null 
  }
}
