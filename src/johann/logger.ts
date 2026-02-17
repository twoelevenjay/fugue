import * as vscode from 'vscode';
import { getConfig } from './config';

// ============================================================================
// LOGGER — Structured logging via VS Code OutputChannel
//
// All Johann subsystems log through this central logger:
// - Respects the log level from configuration
// - Writes to a dedicated VS Code output channel ("Johann")
// - Timestamps all entries
// - Supports structured context objects
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/**
 * Central logger for Johann.
 */
export class JohannLogger {
    private channel: vscode.OutputChannel;
    private level: LogLevel;

    constructor(channel?: vscode.OutputChannel) {
        this.channel = channel || vscode.window.createOutputChannel('Johann');
        this.level = getConfig().logLevel;
    }

    /**
     * Update the log level (e.g., when config changes).
     */
    setLevel(level: LogLevel): void {
        this.level = level;
    }

    /**
     * Refresh the log level from config.
     */
    refreshLevel(): void {
        this.level = getConfig().logLevel;
    }

    /**
     * Log a debug message.
     */
    debug(message: string, context?: Record<string, unknown>): void {
        this.log('debug', message, context);
    }

    /**
     * Log an info message.
     */
    info(message: string, context?: Record<string, unknown>): void {
        this.log('info', message, context);
    }

    /**
     * Log a warning.
     */
    warn(message: string, context?: Record<string, unknown>): void {
        this.log('warn', message, context);
    }

    /**
     * Log an error.
     */
    error(message: string, context?: Record<string, unknown>): void {
        this.log('error', message, context);
    }

    /**
     * Log a message at a specific level.
     */
    private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
        if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

        let line = `${prefix} ${message}`;
        if (context) {
            line += ` | ${JSON.stringify(context)}`;
        }

        this.channel.appendLine(line);
    }

    /**
     * Show the output channel in VS Code.
     */
    show(): void {
        this.channel.show();
    }

    /**
     * Get the underlying output channel.
     */
    getChannel(): vscode.OutputChannel {
        return this.channel;
    }

    /**
     * Dispose of the logger.
     */
    dispose(): void {
        this.channel.dispose();
    }
}

/**
 * Singleton logger instance.
 * Call createLogger() to initialize, then getLogger() to access.
 */
let _logger: JohannLogger | undefined;

/**
 * Create and return the singleton logger.
 */
export function createLogger(channel?: vscode.OutputChannel): JohannLogger {
    if (!_logger) {
        _logger = new JohannLogger(channel);
    }
    return _logger;
}

/**
 * Get the singleton logger. Creates one if needed.
 */
export function getLogger(): JohannLogger {
    if (!_logger) {
        _logger = new JohannLogger();
    }
    return _logger;
}
