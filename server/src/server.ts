/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as ts from 'typescript';
// import * as fs from 'fs';


import {
	CompletionItem,
	CompletionItemKind,
	createConnection, ProposedFeatures,
	TextDocumentPositionParams,
	TextDocuments,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { parse } from '@vue/compiler-sfc';

/** -----LogLevel---- */
const logLevelArg = process.argv.find(arg => arg.startsWith('--log-level='));
const logLevel = logLevelArg ? logLevelArg.split('=')[1] : 'info';

function log(msg: string, level: 'info'|'debug' = 'info') {
	if ((level === 'debug' && logLevel === 'debug') || level === 'info') {console.log(`[LSP ${level}] ${msg}`);}
}
/** -----LogLevel---- */

/** -----Parse Vue Script---- */
function parseVueScript(content: string): {
	script: string;
	scriptStartOffset: number;
	mapExportOffset: (originalPos: number) => number;
} {
	const { script } = parse({ source: content });
	if (!script) { return { script: '', scriptStartOffset: 0, mapExportOffset: (p) => p }; }

	const original = script.content;
	const match = original.match(/export\s+default/);
	const replaced = original.replace(/export\s+default/, 'const __VLS_component');

	const matchIndex = match ? match.index! : -1;
	const matchLen   = match ? match[0].length : 0;
	const replLen    = 'const __VLS_component'.length;
	const delta      = replLen - matchLen;

	function mapExportOffset(originalPos: number): number {
		if (matchIndex < 0 || originalPos <= matchIndex) { return originalPos; }
		if (originalPos < matchIndex + matchLen) { return matchIndex + replLen; }
		return originalPos + delta;
	}

	return {
		script: replaced,
		scriptStartOffset: script.start,
		mapExportOffset,
	};
}
/** -----Parse Vue Script---- */

/** -----Inject this: __VLS_Context---- */
function injectThisParam(scriptContent: string): {
	result: string;
	mapOffset: (originalPos: number) => number;
} {
	const sf = ts.createSourceFile('v.ts', scriptContent, ts.ScriptTarget.Latest, true);
	const insertions: { pos: number; text: string }[] = [];

	function isInsideVLSComponent(node: ts.Node): boolean {
		let cur: ts.Node | undefined = node.parent;
		while (cur) {
			if (
				ts.isVariableDeclaration(cur) &&
				ts.isIdentifier(cur.name) &&
				cur.name.text === '__VLS_component'
			) { return true; }
			cur = cur.parent;
		}
		return false;
	}

	// Clés de __VLS_component dont TOUTES les fonctions imbriquées
	// ne doivent PAS recevoir this: __VLS_Context
	// (leur type de retour alimente __VLS_Context → circularité si this est typé)
	const NO_INJECT_KEYS = new Set(['data', 'computed']);

	// Retourne la clé de premier niveau dans __VLS_component qui contient ce nœud.
	// Ex: data()             → 'data'
	//     pistache() dans computed → 'computed'
	//     mounted()          → 'mounted'
	function getTopLevelVLSKey(node: ts.FunctionExpression | ts.MethodDeclaration): string | null {
		// Initialiser avec la clé propre du nœud (cas : enfant direct de __VLS_component)
		let lastKey: string | null = null;
		if (ts.isMethodDeclaration(node)) {
			const k = node.name;
			if (ts.isIdentifier(k) || ts.isStringLiteral(k)) { lastKey = k.text; }
		} else if (ts.isFunctionExpression(node) && ts.isPropertyAssignment(node.parent)) {
			const k = (node.parent as ts.PropertyAssignment).name;
			if (ts.isIdentifier(k) || ts.isStringLiteral(k)) { lastKey = k.text; }
		}

		// Remonter : le dernier MethodDeclaration/PropertyAssignment rencontré
		// avant __VLS_component est la clé de premier niveau.
		let cur: ts.Node | undefined = node.parent;
		while (cur) {
			if (
				ts.isVariableDeclaration(cur) &&
				ts.isIdentifier(cur.name) &&
				cur.name.text === '__VLS_component'
			) { return lastKey; }
			if (ts.isMethodDeclaration(cur) || ts.isPropertyAssignment(cur)) {
				const nameNode = (cur as ts.MethodDeclaration | ts.PropertyAssignment).name;
				if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) {
					lastKey = nameNode.text;
				}
			}
			cur = cur.parent;
		}
		return null;
	}

	function visit(node: ts.Node) {
		if (ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) {
			if (isInsideVLSComponent(node)) {
				const topKey = getTopLevelVLSKey(node);
				if (topKey && NO_INJECT_KEYS.has(topKey)) {
					// Pas d'injection sous data/computed : évite la circularité
					// (this. dans ces fonctions passe par le fallback __VLS_ctx. de onCompletion)
					ts.forEachChild(node, visit);
					return;
				}
				const firstParam = node.parameters[0];
				const alreadyHasThis =
					firstParam &&
					ts.isIdentifier(firstParam.name) &&
					firstParam.name.text === 'this';
				if (!alreadyHasThis) {
					const hasOtherParams = node.parameters.length > 0;
					insertions.push({
						pos: node.parameters.pos,
						text: hasOtherParams ? 'this: __VLS_Context, ' : 'this: __VLS_Context',
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);

	// Tri croissant pour le mapping d'offset
	const sortedAsc = [...insertions].sort((a, b) => a.pos - b.pos);

	// Pour chaque position originale, calcule la position dans le texte injecté
	function mapOffset(originalPos: number): number {
		let shift = 0;
		for (const ins of sortedAsc) {
			// L'insertion est avant ou au niveau du curseur original → décale
			if (ins.pos <= originalPos) {
				shift += ins.text.length;
			} else {
				break;
			}
		}
		return originalPos + shift;
	}

	// Appliquer en ordre inverse pour ne pas décaler les positions
	insertions.sort((a, b) => b.pos - a.pos);
	let result = scriptContent;
	for (const ins of insertions) {
		result = result.slice(0, ins.pos) + ins.text + result.slice(ins.pos);
	}
	return { result, mapOffset };
}
/** -----Inject this: __VLS_Context---- */


/** -----Strip SpreadAssignments from data()---- */
// Les ...spread dans le return de data() typent infos comme any → retour any → __VLS_Data = any.
// On les supprime du script virtuel : les propriétés explicites restent et sont bien inférées.
function stripSpreadsFromData(scriptContent: string): string {
	const sf = ts.createSourceFile('v.ts', scriptContent, ts.ScriptTarget.Latest, true);
	const removals: Array<{ pos: number; end: number }> = [];

	function isInsideDataReturn(node: ts.Node): boolean {
		let cur: ts.Node | undefined = node.parent;
		let inReturn = false;
		while (cur) {
			if (ts.isReturnStatement(cur)) { inReturn = true; }
			if (inReturn && ts.isMethodDeclaration(cur)) {
				const key = cur.name;
				if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'data') {
					return true;
				}
			}
			// Également gérer la forme data: function() {}
			if (inReturn && ts.isFunctionExpression(cur) && ts.isPropertyAssignment(cur.parent)) {
				const key = (cur.parent as ts.PropertyAssignment).name;
				if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === 'data') {
					return true;
				}
			}
			cur = cur.parent;
		}
		return false;
	}

	function visit(node: ts.Node) {
		if (ts.isSpreadAssignment(node) && isInsideDataReturn(node)) {
			// Inclure la virgule éventuelle qui suit
			let end = node.end;
			const after = scriptContent.slice(end, end + 2);
			if (after.startsWith(',')) { end += 1; }
			removals.push({ pos: node.pos, end });
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);

	// Appliquer en ordre inverse
	removals.sort((a, b) => b.pos - a.pos);
	let result = scriptContent;
	for (const r of removals) {
		result = result.slice(0, r.pos) + result.slice(r.end);
	}
	return result;
}
/** -----Strip SpreadAssignments from data()---- */



const host: ts.LanguageServiceHost = {
	getScriptFileNames: () => Object.keys(files),

	getScriptVersion: (filename) => files[filename]?.version.toString(),

	getScriptSnapshot: (fileName) => {
		const file = files[fileName];
		if (!file) {return undefined;}
		return ts.ScriptSnapshot.fromString(file.content);
	},

	getCurrentDirectory: () => process.cwd(),

	getCompilationSettings: () => ({
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: false
  }),

  getDefaultLibFileName: (options) =>
    ts.getDefaultLibFilePath(options),

  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory
};

const languageService = ts.createLanguageService(host);



function generateVirtualFile(script: string): { content: string; mapOffset: (originalPos: number) => number } {
	// 1. Supprimer les spreads ...xxx dans data() pour éviter que any contamine le type de retour
	const stripped = stripSpreadsFromData(script);
	// 2. Injecter this: __VLS_Context dans les méthodes/hooks (pas data/computed)
	const { result: injected, mapOffset } = injectThisParam(stripped);
	const content =
`${injected}

// ---- Inférence de types depuis le composant Vue ----

// data() → ReturnType évite la circularité avec this: __VLS_Context
type __VLS_Data = typeof __VLS_component extends { data(...args: any[]): infer D } ? D : {};

// computed : forme fonction ou { get() }
type __VLS_Computed =
  typeof __VLS_component extends { computed: infer C } ? {
    [K in keyof C]: C[K] extends { get(this: any): infer R }
      ? R
      : C[K] extends (this: any, ...args: any[]) => infer R
      ? R
      : never;
  } : {};

// methods
type __VLS_Methods =
  typeof __VLS_component extends { methods: infer M } ? M : {};

// props
type __VLS_Props =
  typeof __VLS_component extends { props: infer P } ? P : {};

// Hooks de cycle de vie Vue.js
type __VLS_Hooks = {
  beforeCreate?(this: __VLS_Context): void;
  created?(this: __VLS_Context): void;
  beforeMount?(this: __VLS_Context): void;
  mounted?(this: __VLS_Context): void;
  beforeUpdate?(this: __VLS_Context): void;
  updated?(this: __VLS_Context): void;
  beforeDestroy?(this: __VLS_Context): void;
  destroyed?(this: __VLS_Context): void;
  beforeUnmount?(this: __VLS_Context): void;
  unmounted?(this: __VLS_Context): void;
  activated?(this: __VLS_Context): void;
  deactivated?(this: __VLS_Context): void;
  errorCaptured?(this: __VLS_Context, err: unknown, vm: unknown, info: string): boolean | void;
};

// Contexte complet
type __VLS_Context = __VLS_Data & __VLS_Computed & __VLS_Methods & __VLS_Props & __VLS_Hooks;

// Déclencheur d'autocomplétion de secours (hors corps de méthode)
declare const __VLS_ctx: __VLS_Context;
__VLS_ctx.
`;
	log(`generateVirtualFile::virtualFile:\n${content}`, 'info');
	return { content, mapOffset };
}

/** -----LSP Setup---- */
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

connection.onInitialize(() => ({ capabilities: { completionProvider: { resolveProvider: false } } }));
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
	log("COMPLETION CALLED", 'info');
	const doc = documents.get(params.textDocument.uri);
	if (!doc) {return [];}

	const vueContent = doc.getText();
	const { script, scriptStartOffset, mapExportOffset } = parseVueScript(vueContent);
	const { content: virtualContent, mapOffset } = generateVirtualFile(script);

	const fileName = 'virtual.ts';
	files[fileName] = {
		version: (files[fileName]?.version ?? 0) + 1,
		content: virtualContent,
	};

	const docOffset      = doc.offsetAt(params.position);
	const relativeOffset = docOffset - scriptStartOffset;
	const isInsideScript = relativeOffset >= 0 && relativeOffset <= script.length;

	let offset: number;

	if (isInsideScript) {
		// Texte avant le curseur dans le script original (pour détecter this. / this.xxx.)
		const textBefore = script.slice(0, mapExportOffset(relativeOffset));

		// Cas 1 : this.xxx.  → complétion sur le type de xxx
		const chainMatch = textBefore.match(/\bthis\.(\w+)\.$/);
		if (chainMatch) {
			const prop = chainMatch[1];
			// On place le curseur après "__VLS_ctx.<prop>." dans le fichier virtuel
			const chainMarker = `__VLS_ctx.${prop}.`;
			// Injecter une ligne de complétion chaînée à la fin du fichier virtuel
			const chainedContent = virtualContent.replace(
				/declare const __VLS_ctx: __VLS_Context;\n__VLS_ctx\.\n/,
				`declare const __VLS_ctx: __VLS_Context;\n__VLS_ctx.${prop}.\n`
			);
			files[fileName] = {
				version: (files[fileName].version) + 1,
				content: chainedContent,
			};
			offset = chainedContent.lastIndexOf(chainMarker) + chainMarker.length;
			log(`Chain completion: this.${prop}. → offset ${offset}`, 'info');

		// Cas 2 : this.  → complétion sur __VLS_Context (data + computed + methods + hooks)
		} else if (textBefore.match(/\bthis\.$/)) {
			const marker = '__VLS_ctx.';
			offset = virtualContent.lastIndexOf(marker) + marker.length;
			log(`this. completion → fallback offset ${offset}`, 'info');

		// Cas 3 : position brute dans le script → variables locales, globals, etc.
		} else {
			const afterExport = mapExportOffset(relativeOffset);
			offset = mapOffset(afterExport);
			log(`Raw cursor mapped: rel=${relativeOffset} export=${afterExport} virtual=${offset}`, 'info');
		}
	} else {
		const marker = '__VLS_ctx.';
		offset = virtualContent.lastIndexOf(marker) + marker.length;
		log(`Outside script, fallback offset ${offset}`, 'debug');
	}

	const completions = languageService.getCompletionsAtPosition(fileName, offset, {});
	if (!completions) {return [];}

	return completions.entries.map(entry => ({
		label: entry.name,
		kind: CompletionItemKind.Property,
	}));
});

connection.listen();