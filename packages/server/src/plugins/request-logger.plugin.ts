import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { writeFile, appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

interface RequestLogEntry {
  timestamp: string;
  sessionId: string;
  preset?: string;
  request: {
    model?: string;
    max_tokens?: number;
    temperature?: number;
    system?: string | any[];
    messages: any[];
    tools?: any[];
    stream?: boolean;
  };
  response: {
    id?: string;
    model?: string;
    role?: string;
    content?: any[];
    fullText?: string;  // For streaming responses, accumulated text
    stop_reason?: string;
    stop_sequence?: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  duration_ms?: number;
  error?: any;
}

interface RequestLoggerOptions {
  enabled?: boolean;
  logFilePath?: string;
  includeSystemPrompt?: boolean;  // Whether to include system prompt (can be long)
  includeMessages?: boolean;       // Whether to include full message history
  includeTools?: boolean;          // Whether to include tools definition
  maxMessageLength?: number;       // Max length for each message (0 = unlimited)
}

const register: FastifyPluginAsync<RequestLoggerOptions> = async (fastify, options) => {
  const {
    enabled = true,
    logFilePath,
    includeSystemPrompt = true,
    includeMessages = true,
    includeTools = false,
    maxMessageLength = 0
  } = options;

  if (!enabled) {
    fastify.log.info('Request logger plugin is disabled');
    return;
  }

  const logFile = logFilePath || join(homedir(), '.claude-code-router', 'api-requests.jsonl');
  const logDir = join(homedir(), '.claude-code-router');

  // Ensure log directory exists
  if (!existsSync(logDir)) {
    await mkdir(logDir, { recursive: true });
  }

  // Initialize log file
  if (!existsSync(logFile)) {
    await writeFile(logFile, '', 'utf-8');
    fastify.log.info(`Created request log file: ${logFile}`);
  }

  fastify.log.info(`Request logger plugin enabled. Logging to: ${logFile}`);

  // Helper function to truncate long strings
  const truncate = (str: string, maxLength: number): string => {
    if (maxLength === 0 || str.length <= maxLength) return str;
    return str.substring(0, maxLength) + `... [truncated, ${str.length - maxLength} more chars]`;
  };

  // Helper function to sanitize message content
  const sanitizeMessages = (messages: any[]): any[] => {
    if (!includeMessages) return [];
    if (!messages) return [];

    return messages.map(msg => {
      const sanitized: any = { role: msg.role };

      if (typeof msg.content === 'string') {
        sanitized.content = maxMessageLength > 0
          ? truncate(msg.content, maxMessageLength)
          : msg.content;
      } else if (Array.isArray(msg.content)) {
        sanitized.content = msg.content.map((item: any) => {
          if (item.type === 'text' && item.text) {
            return {
              type: 'text',
              text: maxMessageLength > 0 ? truncate(item.text, maxMessageLength) : item.text
            };
          }
          if (item.type === 'image') {
            return { type: 'image', source: '[IMAGE_DATA_OMITTED]' };
          }
          if (item.type === 'tool_use') {
            return { type: 'tool_use', name: item.name, id: item.id };
          }
          if (item.type === 'tool_result') {
            return { type: 'tool_result', tool_use_id: item.tool_use_id };
          }
          return item;
        });
      }

      return sanitized;
    });
  };

  // Hook to capture request
  fastify.addHook('preHandler', async (req: any) => {
    if (req.pathname?.endsWith('/v1/messages')) {
      req.requestStartTime = Date.now();

      const logEntry: RequestLogEntry = {
        timestamp: new Date().toISOString(),
        sessionId: req.sessionId || 'unknown',
        preset: req.preset,
        request: {
          model: req.body?.model,
          max_tokens: req.body?.max_tokens,
          temperature: req.body?.temperature,
          stream: req.body?.stream,
          messages: sanitizeMessages(req.body?.messages || []),
        },
        response: {}
      };

      // Include system prompt if enabled
      if (includeSystemPrompt && req.body?.system) {
        if (typeof req.body.system === 'string') {
          logEntry.request.system = maxMessageLength > 0
            ? truncate(req.body.system, maxMessageLength * 2)
            : req.body.system;
        } else {
          logEntry.request.system = req.body.system;
        }
      }

      // Include tools if enabled
      if (includeTools && req.body?.tools) {
        logEntry.request.tools = req.body.tools.map((tool: any) => ({
          name: tool.name,
          description: tool.description
        }));
      }

      req.logEntry = logEntry;
    }
  });

  // Hook to capture streaming response content
  fastify.addHook('onSend', async (req: any, reply: any, payload: any) => {
    if (!req.logEntry) return payload;

    const logEntry = req.logEntry as RequestLogEntry;
    logEntry.duration_ms = Date.now() - req.requestStartTime;

    // Handle streaming response
    if (payload instanceof ReadableStream) {
      const [loggingStream, originalStream] = payload.tee();

      // Collect streaming data in background
      (async () => {
        const reader = loggingStream.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let lastUsage: any = null;
        let lastStopReason: string | undefined;
        let messageId: string | undefined;
        let model: string | undefined;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));

                  // Capture message_start
                  if (data.type === 'message_start') {
                    messageId = data.message?.id;
                    model = data.message?.model;
                  }

                  // Capture text content
                  if (data.type === 'content_block_delta' && data.delta?.text) {
                    fullText += data.delta.text;
                  }

                  // Capture tool use
                  if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
                    if (!logEntry.response.content) {
                      logEntry.response.content = [];
                    }
                    logEntry.response.content.push({
                      type: 'tool_use',
                      name: data.content_block.name,
                      id: data.content_block.id
                    });
                  }

                  // Capture message_delta with usage
                  if (data.type === 'message_delta') {
                    if (data.usage) {
                      lastUsage = data.usage;
                    }
                    if (data.delta?.stop_reason) {
                      lastStopReason = data.delta.stop_reason;
                    }
                  }
                } catch (e) {
                  // Skip invalid JSON
                }
              }
            }
          }

          // Update log entry with collected data
          logEntry.response.id = messageId;
          logEntry.response.model = model;
          logEntry.response.fullText = fullText;
          logEntry.response.stop_reason = lastStopReason;

          if (lastUsage) {
            logEntry.response.usage = lastUsage;
          }

          // Write to log file
          await appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf-8');

        } catch (error: any) {
          fastify.log.error(`Error collecting streaming response: ${error.message}`);
        }
      })();

      return originalStream;
    }

    // Handle non-streaming response
    if (typeof payload === 'object') {
      if (payload.error) {
        logEntry.error = {
          type: payload.error.type,
          message: payload.error.message
        };
      } else {
        logEntry.response.id = payload.id;
        logEntry.response.model = payload.model;
        logEntry.response.role = payload.role;
        logEntry.response.content = payload.content;
        logEntry.response.stop_reason = payload.stop_reason;
        logEntry.response.stop_sequence = payload.stop_sequence;
        logEntry.response.usage = payload.usage;

        // Extract text content
        if (Array.isArray(payload.content)) {
          const textContent = payload.content
            .filter((item: any) => item.type === 'text')
            .map((item: any) => item.text)
            .join('\n');
          if (textContent) {
            logEntry.response.fullText = textContent;
          }
        }
      }

      // Write to log file
      await appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf-8');
    }

    return payload;
  });

  // Hook to capture errors
  fastify.addHook('onError', async (req: any, reply: any, error: any) => {
    if (req.logEntry) {
      const logEntry = req.logEntry as RequestLogEntry;
      logEntry.duration_ms = Date.now() - req.requestStartTime;
      logEntry.error = {
        message: error.message,
        stack: error.stack,
        code: error.code
      };

      await appendFile(logFile, JSON.stringify(logEntry) + '\n', 'utf-8');
    }
  });
};

export const requestLoggerPlugin = {
  name: 'request-logger',
  version: '1.0.0',
  description: 'Log all API requests and responses with full input/output details',
  register: fp(register, {
    name: 'request-logger-plugin',
    fastify: '5.x'
  })
};
