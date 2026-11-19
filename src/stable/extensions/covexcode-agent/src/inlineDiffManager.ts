/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { computeCombinedDiff, InlineDiffHunk } from './inlineDiff';
import type { ReviewController } from './reviewController';

export interface InlineDiffSession {
	uri: vscode.Uri;
	fsPath: string;
	beforeContent: string;
	afterContent: string;
	hunks: InlineDiffHunk[];
	initialHunkCount: number;
	acceptedHunkCount: number;
	rejectedHunkCount: number;
	document: vscode.TextDocument;
}

function normalizeUriKey(uri: vscode.Uri | string): string {
	const uriStr = typeof uri === 'string' ? uri : uri.toString();
	try {
		const parsed = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
		if (parsed.scheme === 'file') {
			let fsPath = parsed.fsPath;
			try {
				fsPath = fs.realpathSync(fsPath);
			} catch {}
			return vscode.Uri.file(fsPath).toString().toLowerCase();
		}
	} catch {}
	return uriStr.toLowerCase();
}

export class InlineDiffManager implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly activeSessions = new Map<string, InlineDiffSession>();
	private readonly codeLensEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.codeLensEmitter.event;

	private readonly addBaseDecoration: vscode.TextEditorDecorationType;
	private readonly deleteBaseDecoration: vscode.TextEditorDecorationType;
	private readonly addBorderSingle: vscode.TextEditorDecorationType;
	private readonly addBorderTop: vscode.TextEditorDecorationType;
	private readonly addBorderMid: vscode.TextEditorDecorationType;
	private readonly addBorderBottom: vscode.TextEditorDecorationType;
	private readonly deleteBorderSingle: vscode.TextEditorDecorationType;
	private readonly deleteBorderTop: vscode.TextEditorDecorationType;
	private readonly deleteBorderMid: vscode.TextEditorDecorationType;
	private readonly deleteBorderBottom: vscode.TextEditorDecorationType;

	private reviewController?: ReviewController;

	constructor(reviewController?: ReviewController) {
		this.reviewController = reviewController;
		this.addBaseDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});
		this.deleteBaseDecoration = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});

		this.addBorderSingle = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'),
		});
		this.addBorderTop = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '1px 1px 0 1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'),
		});
		this.addBorderMid = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '0 1px 0 1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'),
		});
		this.addBorderBottom = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '0 1px 1px 1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'),
		});

		this.deleteBorderSingle = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
		});
		this.deleteBorderTop = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '1px 1px 0 1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
		});
		this.deleteBorderMid = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '0 1px 0 1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
		});
		this.deleteBorderBottom = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			borderWidth: '0 1px 1px 1px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
		});

		for (const dec of [
			this.addBaseDecoration, this.deleteBaseDecoration,
			this.addBorderSingle, this.addBorderTop, this.addBorderMid, this.addBorderBottom,
			this.deleteBorderSingle, this.deleteBorderTop, this.deleteBorderMid, this.deleteBorderBottom,
		]) {
			this.disposables.push(dec);
		}

		this.disposables.push(
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
				onDidChangeCodeLenses: this.onDidChangeCodeLenses,
				provideCodeLenses: (document: vscode.TextDocument) => this.provideCodeLenses(document),
			})
		);

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
				if (editor) {
					const session = this.getActiveSession(editor.document.uri);
					if (session) {
						this.applyDecorations(editor);
					}
				}
			}),
			vscode.window.onDidChangeVisibleTextEditors((editors: readonly vscode.TextEditor[]) => {
				for (const editor of editors) {
					const session = this.getActiveSession(editor.document.uri);
					if (session) {
						this.applyDecorations(editor);
					}
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((event: vscode.TextEditorSelectionChangeEvent) => {
				const session = this.getActiveSession(event.textEditor.document.uri);
				if (session) {
					this.applyDecorations(event.textEditor);
				}
			}),
			vscode.workspace.onDidCloseTextDocument((closedDoc: vscode.TextDocument) => {
				const normClosed = normalizeUriKey(closedDoc.uri);
				const hasVisible = vscode.window.visibleTextEditors.some(
					(e: vscode.TextEditor) => normalizeUriKey(e.document.uri) === normClosed
				);
				if (!hasVisible) {
					this.removeSession(closedDoc.uri);
				}
			})
		);
	}

	setReviewController(controller: ReviewController): void {
		this.reviewController = controller;
	}

	private setSession(session: InlineDiffSession): void {
		const rawUri = session.uri.toString();
		const docUri = session.document.uri.toString();
		const normDoc = normalizeUriKey(session.document.uri);
		const normRaw = normalizeUriKey(session.uri);

		this.activeSessions.set(rawUri, session);
		this.activeSessions.set(docUri, session);
		this.activeSessions.set(normDoc, session);
		this.activeSessions.set(normRaw, session);
	}

	private removeSession(uri: vscode.Uri | string): void {
		const raw = typeof uri === 'string' ? uri : uri.toString();
		const norm = normalizeUriKey(uri);
		const session = this.activeSessions.get(raw) || this.activeSessions.get(norm);
		if (session) {
			this.activeSessions.delete(session.uri.toString());
			this.activeSessions.delete(session.document.uri.toString());
			this.activeSessions.delete(normalizeUriKey(session.document.uri));
			this.activeSessions.delete(normalizeUriKey(session.uri));
		}
		this.activeSessions.delete(raw);
		this.activeSessions.delete(norm);
	}

	getActiveSession(uri: vscode.Uri | string): InlineDiffSession | undefined {
		const raw = typeof uri === 'string' ? uri : uri.toString();
		const direct = this.activeSessions.get(raw);
		if (direct) {
			return direct;
		}
		const norm = normalizeUriKey(uri);
		return this.activeSessions.get(norm);
	}

	hasActiveDiffs(): boolean {
		return this.activeSessions.size > 0;
	}

	async showDiff(fileUri: vscode.Uri, beforeContent: string, afterContent?: string): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(fileUri);
		const existing = this.getActiveSession(doc.uri) || this.getActiveSession(fileUri);
		if (existing) {
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			this.applyDecorations(editor);
			if (existing.hunks.length > 0) {
				const firstPos = new vscode.Position(existing.hunks[0].startLine, 0);
				editor.revealRange(new vscode.Range(firstPos, firstPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
			return;
		}

		const effectiveAfter = afterContent !== undefined ? afterContent : doc.getText();
		const { combinedText, hunks } = computeCombinedDiff(beforeContent, effectiveAfter);

		const editor = await vscode.window.showTextDocument(doc, { preview: false });

		if (hunks.length === 0) {
			return;
		}

		const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
		const applied = await editor.edit((builder: vscode.TextEditorEdit) => {
			builder.replace(fullRange, combinedText);
		});

		if (!applied) {
			return;
		}

		const session: InlineDiffSession = {
			uri: fileUri,
			fsPath: fileUri.fsPath,
			beforeContent,
			afterContent: effectiveAfter,
			hunks,
			initialHunkCount: hunks.length,
			acceptedHunkCount: 0,
			rejectedHunkCount: 0,
			document: doc,
		};

		this.setSession(session);
		this.applyDecorations(editor);
		this.codeLensEmitter.fire();

		if (hunks.length > 0) {
			const firstPos = new vscode.Position(hunks[0].startLine, 0);
			editor.revealRange(new vscode.Range(firstPos, firstPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const session = this.getActiveSession(document.uri);
		if (!session || session.hunks.length === 0) {
			return [];
		}
		const lenses: vscode.CodeLens[] = [];
		for (let idx = 0; idx < session.hunks.length; idx++) {
			const hunk = session.hunks[idx];
			const pos = new vscode.Position(hunk.startLine, 0);
			const range = new vscode.Range(pos, pos);
			lenses.push(
				new vscode.CodeLens(range, {
					title: '$(check) Accept',
					tooltip: 'Accept this change',
					command: 'covexcode.inlineDiff.accept',
					arguments: [document.uri.toString(), idx],
				}),
				new vscode.CodeLens(range, {
					title: '$(chrome-close) Reject',
					tooltip: 'Reject this change',
					command: 'covexcode.inlineDiff.reject',
					arguments: [document.uri.toString(), idx],
				})
			);
		}
		return lenses;
	}

	private applyDecorations(editor: vscode.TextEditor): void {
		const session = this.activeSessions.get(editor.document.uri.toString());
		if (!session) {
			this.clearDecorations(editor);
			return;
		}

		const addRanges: vscode.Range[] = [];
		const delRanges: vscode.Range[] = [];

		for (const hunk of session.hunks) {
			if (hunk.deletedCount > 0) {
				const start = hunk.startLine;
				const end = hunk.startLine + hunk.deletedCount - 1;
				if (end < editor.document.lineCount) {
					delRanges.push(new vscode.Range(start, 0, end, editor.document.lineAt(end).range.end.character));
				}
			}
			if (hunk.addedCount > 0) {
				const start = hunk.startLine + hunk.deletedCount;
				const end = start + hunk.addedCount - 1;
				if (end < editor.document.lineCount) {
					addRanges.push(new vscode.Range(start, 0, end, editor.document.lineAt(end).range.end.character));
				}
			}
		}

		editor.setDecorations(this.addBaseDecoration, addRanges);
		editor.setDecorations(this.deleteBaseDecoration, delRanges);
		this.applyBorders(editor, addRanges, 'add');
		this.applyBorders(editor, delRanges, 'del');
	}

	private applyBorders(editor: vscode.TextEditor, ranges: vscode.Range[], type: 'add' | 'del'): void {
		const single: vscode.Range[] = [];
		const top: vscode.Range[] = [];
		const mid: vscode.Range[] = [];
		const bottom: vscode.Range[] = [];

		for (const range of ranges) {
			const startLine = range.start.line;
			const endLine = range.end.line;
			if (startLine === endLine) {
				single.push(range);
			} else {
				top.push(editor.document.lineAt(startLine).range);
				if (endLine > startLine + 1) {
					mid.push(new vscode.Range(
						new vscode.Position(startLine + 1, 0),
						editor.document.lineAt(endLine - 1).range.end
					));
				}
				bottom.push(editor.document.lineAt(endLine).range);
			}
		}

		if (type === 'add') {
			editor.setDecorations(this.addBorderSingle, single);
			editor.setDecorations(this.addBorderTop, top);
			editor.setDecorations(this.addBorderMid, mid);
			editor.setDecorations(this.addBorderBottom, bottom);
		} else {
			editor.setDecorations(this.deleteBorderSingle, single);
			editor.setDecorations(this.deleteBorderTop, top);
			editor.setDecorations(this.deleteBorderMid, mid);
			editor.setDecorations(this.deleteBorderBottom, bottom);
		}
	}

	private clearDecorations(editor: vscode.TextEditor): void {
		editor.setDecorations(this.addBaseDecoration, []);
		editor.setDecorations(this.deleteBaseDecoration, []);
		editor.setDecorations(this.addBorderSingle, []);
		editor.setDecorations(this.addBorderTop, []);
		editor.setDecorations(this.addBorderMid, []);
		editor.setDecorations(this.addBorderBottom, []);
		editor.setDecorations(this.deleteBorderSingle, []);
		editor.setDecorations(this.deleteBorderTop, []);
		editor.setDecorations(this.deleteBorderMid, []);
		editor.setDecorations(this.deleteBorderBottom, []);
	}

	async acceptHunk(uriStr: string, hunkIndex: number): Promise<void> {
		const session = this.getActiveSession(uriStr);
		if (!session || hunkIndex < 0 || hunkIndex >= session.hunks.length) {
			return;
		}
		const hunk = session.hunks[hunkIndex];
		const normUri = normalizeUriKey(uriStr);
		const editor = vscode.window.visibleTextEditors.find(
			(e: vscode.TextEditor) => normalizeUriKey(e.document.uri) === normUri
		);
		if (!editor) {
			return;
		}

		if (hunk.deletedCount > 0) {
			const startLine = hunk.startLine;
			const endLine = hunk.startLine + hunk.deletedCount - 1;
			const lineCount = editor.document.lineCount;
			let deleteRange: vscode.Range;
			if (endLine < lineCount - 1) {
				deleteRange = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine + 1, 0));
			} else if (startLine > 0) {
				deleteRange = new vscode.Range(editor.document.lineAt(startLine - 1).range.end, editor.document.lineAt(endLine).range.end);
			} else {
				deleteRange = new vscode.Range(new vscode.Position(0, 0), editor.document.lineAt(endLine).range.end);
			}

			await editor.edit((builder: vscode.TextEditorEdit) => {
				builder.delete(deleteRange);
			});

			for (let i = hunkIndex + 1; i < session.hunks.length; i++) {
				session.hunks[i].startLine -= hunk.deletedCount;
			}
		}

		session.hunks.splice(hunkIndex, 1);
		session.acceptedHunkCount++;

		if (session.hunks.length === 0) {
			await this.finalizeSession(session, true);
		} else {
			this.applyDecorations(editor);
			this.codeLensEmitter.fire();
		}
	}

	async rejectHunk(uriStr: string, hunkIndex: number): Promise<void> {
		const session = this.getActiveSession(uriStr);
		if (!session || hunkIndex < 0 || hunkIndex >= session.hunks.length) {
			return;
		}
		const hunk = session.hunks[hunkIndex];
		const normUri = normalizeUriKey(uriStr);
		const editor = vscode.window.visibleTextEditors.find(
			(e: vscode.TextEditor) => normalizeUriKey(e.document.uri) === normUri
		);
		if (!editor) {
			return;
		}

		if (hunk.addedCount > 0) {
			const startLine = hunk.startLine + hunk.deletedCount;
			const endLine = startLine + hunk.addedCount - 1;
			const lineCount = editor.document.lineCount;
			let deleteRange: vscode.Range;
			if (endLine < lineCount - 1) {
				deleteRange = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine + 1, 0));
			} else if (startLine > 0) {
				deleteRange = new vscode.Range(editor.document.lineAt(startLine - 1).range.end, editor.document.lineAt(endLine).range.end);
			} else {
				deleteRange = new vscode.Range(new vscode.Position(0, 0), editor.document.lineAt(endLine).range.end);
			}

			await editor.edit((builder: vscode.TextEditorEdit) => {
				builder.delete(deleteRange);
			});

			for (let i = hunkIndex + 1; i < session.hunks.length; i++) {
				session.hunks[i].startLine -= hunk.addedCount;
			}
		}

		session.hunks.splice(hunkIndex, 1);
		session.rejectedHunkCount++;

		if (session.hunks.length === 0) {
			const allRejected = session.acceptedHunkCount === 0;
			await this.finalizeSession(session, !allRejected);
		} else {
			this.applyDecorations(editor);
			this.codeLensEmitter.fire();
		}
	}

	async acceptAll(targetPath?: string): Promise<void> {
		const normTarget = targetPath ? normalizeUriKey(targetPath) : undefined;
		const visited = new Set<InlineDiffSession>();
		for (const session of Array.from(this.activeSessions.values())) {
			if (visited.has(session)) {
				continue;
			}
			visited.add(session);
			if (!normTarget || normalizeUriKey(session.document.uri) === normTarget || normalizeUriKey(session.uri) === normTarget || session.fsPath === targetPath) {
				const doc = session.document;
				const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(session.uri, fullRange, session.afterContent);
				await vscode.workspace.applyEdit(edit);
				await this.finalizeSession(session, true);
			}
		}
	}

	async rejectAll(targetPath?: string): Promise<void> {
		const normTarget = targetPath ? normalizeUriKey(targetPath) : undefined;
		const visited = new Set<InlineDiffSession>();
		for (const session of Array.from(this.activeSessions.values())) {
			if (visited.has(session)) {
				continue;
			}
			visited.add(session);
			if (!normTarget || normalizeUriKey(session.document.uri) === normTarget || normalizeUriKey(session.uri) === normTarget || session.fsPath === targetPath) {
				const doc = session.document;
				const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(session.uri, fullRange, session.beforeContent);
				await vscode.workspace.applyEdit(edit);
				await this.finalizeSession(session, false);
			}
		}
	}

	private async finalizeSession(session: InlineDiffSession, wasAccepted: boolean): Promise<void> {
		this.removeSession(session.uri);
		const normDoc = normalizeUriKey(session.document.uri);
		const editors = vscode.window.visibleTextEditors.filter(
			(e: vscode.TextEditor) => normalizeUriKey(e.document.uri) === normDoc
		);
		for (const ed of editors) {
			this.clearDecorations(ed);
		}
		this.codeLensEmitter.fire();

		try {
			const doc = session.document;
			if (doc.isDirty) {
				await doc.save();
			}
		} catch {}

		if (this.reviewController) {
			if (wasAccepted) {
				void this.reviewController.accept([session.fsPath]);
			} else {
				void this.reviewController.reject([session.fsPath]);
			}
		}
	}

	dispose(): void {
		for (const session of this.activeSessions.values()) {
			const editors = vscode.window.visibleTextEditors.filter((e: vscode.TextEditor) => e.document.uri.toString() === session.uri.toString());
			for (const ed of editors) {
				this.clearDecorations(ed);
			}
		}
		this.activeSessions.clear();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}
}
