import { App, ButtonComponent, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { runWhisperCppDiagnostics, type WhisperCppDiagnosticsReport } from './whispercpp-diagnostics';
import { WhisperCppDictationSession } from './whispercpp-dictation';
import { DEFAULT_SETTINGS, normalizeSettings, type WhisperLocalPluginSettings } from './settings';

interface DebugEventEntry {
	timestamp: string;
	message: string;
	data?: unknown;
}

class WhisperLocalSettingTab extends PluginSettingTab {
	private readonly plugin: WhisperLocalPlugin;

	constructor(app: App, plugin: WhisperLocalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Connection')
			.setHeading();

		new Setting(containerEl)
			.setName('Base URL')
			.setDesc('Address of your local whisper.cpp server.')
			.addText((text) => text
				.setPlaceholder(DEFAULT_SETTINGS.baseUrl)
				.setValue(this.plugin.settings.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Language hint')
			.setDesc('Optional language for transcription (for example: en). Leave blank to auto-detect.')
			.addText((text) => text
				.setPlaceholder('Optional, for example: en')
				.setValue(this.plugin.settings.language)
				.onChange(async (value) => {
					this.plugin.settings.language = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Request timeout (ms)')
			.setDesc('Timeout for each whisper.cpp transcription request.')
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS.requestTimeoutMs))
				.setValue(String(this.plugin.settings.requestTimeoutMs))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim(), 10);
					this.plugin.settings.requestTimeoutMs = Number.isFinite(parsed)
						? parsed
						: DEFAULT_SETTINGS.requestTimeoutMs;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Write detailed live dictation traces to the developer console.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Diagnostics')
			.setHeading();

		new Setting(containerEl)
			.setName('Run whisper.cpp checks')
			.setDesc('Verify health, props endpoint, inference dry run, and browser capabilities.')
			.addButton((button) => button
				.setButtonText('Run checks')
				.onClick(() => {
					void this.plugin.runWhisperCppDiagnostics(button);
				}));
	}
}

export default class WhisperLocalPlugin extends Plugin {
	settings: WhisperLocalPluginSettings = { ...DEFAULT_SETTINGS };
	private dictationSession: WhisperCppDictationSession | null = null;
	private ribbonToggleEl: HTMLElement | null = null;
	private readonly debugEvents: DebugEventEntry[] = [];
	private readonly maxDebugEvents = 200;
	private diagnosticsRunning = false;
	private lastDiagnosticsReport: WhisperCppDiagnosticsReport | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.logDebug('Plugin loaded.', {
			version: this.manifest.version,
			baseUrl: this.settings.baseUrl,
			language: this.settings.language || null,
			requestTimeoutMs: this.settings.requestTimeoutMs,
		});

		this.addCommand({
			id: 'show-whisper-local-connection',
			name: 'Show connection details',
			callback: () => {
				new Notice(`Whisper local: ${this.settings.baseUrl}`);
			},
		});

		this.addCommand({
			id: 'print-live-dictation-debug-snapshot',
			name: 'Print live dictation debug snapshot',
			callback: () => {
				this.printDebugSnapshot();
			},
		});

		this.addCommand({
			id: 'run-whisper-local-diagnostics',
			name: 'Run diagnostics',
			callback: () => {
				void this.runWhisperCppDiagnostics();
			},
		});

		this.addCommand({
			id: 'start-live-dictation',
			name: 'Start live dictation',
			callback: () => {
				void this.startLiveDictation();
			},
		});

		this.addCommand({
			id: 'stop-live-dictation',
			name: 'Stop live dictation',
			callback: () => {
				void this.stopLiveDictation(true);
			},
		});

		this.ribbonToggleEl = this.addRibbonIcon('mic', 'Start live dictation', () => {
			void this.toggleLiveDictationFromRibbon();
		});
		this.updateRibbonToggleState();

		this.addSettingTab(new WhisperLocalSettingTab(this.app, this));
	}

	onunload(): void {
		this.logDebug('Plugin unloading.');
		void this.stopLiveDictation(false);
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as unknown;
		this.settings = normalizeSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		await this.saveData(this.settings);
	}

	async runWhisperCppDiagnostics(button?: ButtonComponent): Promise<void> {
		if (this.diagnosticsRunning) {
			new Notice('Whisper.cpp diagnostics are already running.');
			return;
		}

		this.diagnosticsRunning = true;
		if (button) {
			button.setDisabled(true);
			button.setButtonText('Running...');
		}

		this.logDebug('Starting whisper.cpp diagnostics.');
		try {
			const report = await runWhisperCppDiagnostics({
				baseUrl: this.settings.baseUrl,
				language: this.settings.language,
				timeoutMs: this.settings.requestTimeoutMs,
			});
			this.lastDiagnosticsReport = report;
			this.logDebug('whisper.cpp diagnostics completed.', report.summary);
			this.logDiagnosticsToConsole(report);

			const summaryText = `${report.summary.passed} passed, ${report.summary.warned} warnings, ${report.summary.failed} failed`;
			const noticeMessage = report.summary.failed > 0
				? `whisper.cpp checks found issues: ${summaryText}`
				: `whisper.cpp checks complete: ${summaryText}`;
			new Notice(noticeMessage, 9_000);
		} catch (error) {
			console.error('[Whisper Local] Diagnostics failed to complete.', error);
			new Notice('Whisper.cpp diagnostics failed unexpectedly. Check console for details.', 8_000);
		} finally {
			this.diagnosticsRunning = false;
			if (button) {
				button.setDisabled(false);
				button.setButtonText('Run checks');
			}
		}
	}

	private async toggleLiveDictationFromRibbon(): Promise<void> {
		if (this.dictationSession?.isActive) {
			await this.stopLiveDictation(true);
			return;
		}

		await this.startLiveDictation();
	}

	private async startLiveDictation(): Promise<void> {
		if (this.dictationSession?.isActive) {
			this.logDebug('Start requested while session already active.');
			new Notice('Live dictation is already active.');
			return;
		}

		if (!this.getActiveEditor()) {
			this.logDebug('Start blocked because there is no active editor.');
			new Notice('Open a note editor before starting live dictation.');
			return;
		}

		this.logDebug('Starting live dictation.', {
			baseUrl: this.settings.baseUrl,
			language: this.settings.language || null,
			requestTimeoutMs: this.settings.requestTimeoutMs,
		});
		const session = new WhisperCppDictationSession({
			baseUrl: this.settings.baseUrl,
			language: this.settings.language,
			requestTimeoutMs: this.settings.requestTimeoutMs,
		}, {
			onTranscript: (transcript) => {
				this.insertTranscript(transcript);
			},
			onError: (message) => {
				console.error('[Whisper Local] Live dictation error:', message);
				this.logDebug('Live dictation error raised.', { message });
				new Notice(message);
			},
			onDebug: (message, data) => {
				this.logDebug(message, data);
			},
			onStop: () => {
				this.logDebug('Dictation session reported stop.');
				if (this.dictationSession === session) {
					this.dictationSession = null;
					this.updateRibbonToggleState();
				}
			},
		});

		this.dictationSession = session;
		this.updateRibbonToggleState();
		try {
			await session.start();
			this.logDebug('Live dictation started.');
			new Notice('Live dictation started.');
			this.updateRibbonToggleState();
		} catch (error) {
			console.error('[Whisper Local] Failed to start live dictation.', error);
			this.logDebug('Failed to start live dictation.', {
				error: error instanceof Error ? error.message : String(error),
			});
			if (this.dictationSession === session) {
				this.dictationSession = null;
			}
			this.updateRibbonToggleState();
		}
	}

	private async stopLiveDictation(showNotice: boolean): Promise<void> {
		if (!this.dictationSession) {
			this.logDebug('Stop requested while session is not active.');
			if (showNotice) {
				new Notice('Live dictation is not active.');
			}
			return;
		}

		this.logDebug('Stopping live dictation.');
		const session = this.dictationSession;
		this.dictationSession = null;
		this.updateRibbonToggleState();
		await session.stop();
		this.logDebug('Live dictation stopped.');
		this.updateRibbonToggleState();

		if (showNotice) {
			new Notice('Live dictation stopped.');
		}
	}

	private updateRibbonToggleState(): void {
		if (!this.ribbonToggleEl) {
			return;
		}

		const isActive = this.dictationSession?.isActive ?? false;
		const tooltip = isActive ? 'Stop live dictation' : 'Start live dictation';
		setIcon(this.ribbonToggleEl, isActive ? 'square' : 'mic');
		this.ribbonToggleEl.setAttribute('aria-label', tooltip);
		this.ribbonToggleEl.setAttribute('title', tooltip);
		this.ribbonToggleEl.classList.toggle('is-active', isActive);
	}

	private insertTranscript(transcript: string): void {
		const editor = this.getActiveEditor();
		if (!editor) {
			this.logDebug('Transcript dropped because no active editor.', {
				transcriptLength: transcript.length,
			});
			new Notice('Transcription received, but there is no active note editor.');
			return;
		}

		const text = formatTranscriptForInsertion(editor, transcript);
		if (!text) {
			this.logDebug('Transcript ignored after normalization.', {
				transcriptLength: transcript.length,
			});
			return;
		}

		const insertionStart = editor.getCursor();
		const insertionStartOffset = editor.posToOffset(insertionStart);
		editor.replaceRange(text, insertionStart);
		const insertionEnd = editor.offsetToPos(insertionStartOffset + text.length);
		editor.setCursor(insertionEnd);
		this.logDebug('Transcript inserted into editor.', {
			transcriptLength: transcript.length,
			insertedLength: text.length,
		});
	}

	private getActiveEditor(): Editor | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.editor ?? null;
	}

	private logDebug(message: string, data?: unknown): void {
		const entry: DebugEventEntry = {
			timestamp: new Date().toISOString(),
			message,
			data,
		};
		this.debugEvents.push(entry);
		if (this.debugEvents.length > this.maxDebugEvents) {
			this.debugEvents.shift();
		}

		if (!this.settings.enableDebugLogging) {
			return;
		}

		if (typeof data === 'undefined') {
			console.debug('[Whisper Local][Debug]', message);
			return;
		}

		console.debug('[Whisper Local][Debug]', message, data);
	}

	private printDebugSnapshot(): void {
		const sessionSnapshot = this.dictationSession?.getDebugSnapshot() ?? {
			isActive: false,
		};
		const snapshot = {
			timestamp: new Date().toISOString(),
			pluginVersion: this.manifest.version,
			settings: {
				baseUrl: this.settings.baseUrl,
				language: this.settings.language || null,
				requestTimeoutMs: this.settings.requestTimeoutMs,
				enableDebugLogging: this.settings.enableDebugLogging,
			},
			session: sessionSnapshot,
			lastDiagnosticsSummary: this.lastDiagnosticsReport?.summary ?? null,
			recentEvents: this.debugEvents.slice(-60),
		};

		console.debug('[Whisper Local] Live dictation debug snapshot', snapshot);
		new Notice('Whisper local debug snapshot printed to console.');
	}

	private logDiagnosticsToConsole(report: WhisperCppDiagnosticsReport): void {
		console.debug('[Whisper Local] Diagnostics report', report);
		for (const check of report.checks) {
			const prefix = `[Whisper Local][Diagnostics] ${check.label}: ${check.message}`;
			if (check.status === 'fail') {
				console.error(prefix, check.details ?? null);
				continue;
			}

			if (check.status === 'warn') {
				console.warn(prefix, check.details ?? null);
				continue;
			}

			console.debug(prefix, check.details ?? null);
		}
	}
}

function formatTranscriptForInsertion(editor: Editor, transcript: string): string {
	const normalized = transcript.trim();
	if (normalized.length === 0) {
		return '';
	}

	const cursor = editor.getCursor();
	const currentLine = editor.getLine(cursor.line);
	const characterBeforeCursor = cursor.ch > 0 ? currentLine.charAt(cursor.ch - 1) : '';
	const prefix = characterBeforeCursor.length > 0 && !/\s/.test(characterBeforeCursor)
		? ' '
		: '';

	return `${prefix}${normalized} `;
}
