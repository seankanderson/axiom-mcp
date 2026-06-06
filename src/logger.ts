import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { LoggingLevel } from '@modelcontextprotocol/sdk/types.js'

/**
 * MCP-protocol logger. Emits `notifications/message` events that an MCP client
 * can subscribe to and filter by level (controlled by the client via
 * `logging/setLevel`). This is distinct from process stderr — that channel is
 * still used for fatal startup errors in stdio mode where the protocol stream
 * isn't yet up.
 */

const LEVEL_ORDER: Record<LoggingLevel, number> = {
    debug:     0,
    info:      1,
    notice:    2,
    warning:   3,
    error:     4,
    critical:  5,
    alert:     6,
    emergency: 7,
}

export class McpLogger {
    private server: Server | null = null
    private level: LoggingLevel = 'info'

    bind(server: Server): void {
        this.server = server
    }

    setLevel(level: LoggingLevel): void {
        this.level = level
    }

    debug(message: string, data?: Record<string, unknown>):   void { this.emit('debug',   message, data) }
    info(message: string, data?: Record<string, unknown>):    void { this.emit('info',    message, data) }
    notice(message: string, data?: Record<string, unknown>):  void { this.emit('notice',  message, data) }
    warning(message: string, data?: Record<string, unknown>): void { this.emit('warning', message, data) }
    error(message: string, data?: Record<string, unknown>):   void { this.emit('error',   message, data) }

    private emit(level: LoggingLevel, message: string, data?: Record<string, unknown>): void {
        if (!this.server) return
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
        const params = {
            level,
            logger: 'axiom-mcp',
            data: data ? { message, ...data } : { message },
        }
        // sendLoggingMessage returns a promise; we fire-and-forget so the caller
        // (a tool handler) isn't blocked by transport backpressure. Errors here
        // are swallowed deliberately — failing to log must never break a tool.
        void this.server.sendLoggingMessage(params).catch(() => { /* swallow */ })
    }
}

export const logger = new McpLogger()
