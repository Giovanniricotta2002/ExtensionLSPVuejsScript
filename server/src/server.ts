/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as ts from 'typescript';
import * as fs from 'fs';
import * as acorn from 'acorn';

import { Node } from 'acorn';

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


/** -----Types---- */
type TypeNode = 
	| { type: 'String'|'Number'|'Boolean'|'Any' }
	| { type: 'Array', elementType: TypeNode }
	| { type: 'Object', properties: Record<string, TypeNode> }
	| { type: 'Function', returnType?: TypeNode };

interface VueSymbols {
	data: Record<string, TypeNode>;
	computed: Record<string, TypeNode>;
	methods: Record<string, TypeNode>;
	filters: Record<string, TypeNode>;
	hooks: Record<string, TypeNode>;
	options: Record<string, TypeNode>;
};
/** -----Types---- */

/** -----Parse Vue Script---- */
function parseVueScript(content: string): string {
	const { script } = parse({source: content});
	// console.log('parseVueScript::parse', script);
	
	return script?.content ??  '';
}
/** -----Parse Vue Script---- */

/** -----Infer Type---- */
function inferType(node: Node): TypeNode {
	switch(node.type) {
		case 'Literal':
			if (typeof (node as acorn.Literal).value === 'string') {return { type: 'String'};}
			if (typeof (node as acorn.Literal).value === 'number') {return { type: 'Number'};}
			if (typeof (node as acorn.Literal).value === 'boolean') {return { type: 'Boolean'};}
			return {type: 'Any'};
		case 'ArrayExpression':{
			const arrayNode = node as acorn.ArrayExpression;
			const first = arrayNode.elements[0];
			return { type :'Array', elementType: first ? inferType(first) : { type : 'Any' } };
		}
		case 'ObjectExpression': {
			const props: Record<string, TypeNode> = {};
			for (const p of (node as acorn.ObjectExpression).properties) {
				if (p.type == 'SpreadElement') {
					const spred = p as acorn.SpreadElement;
					const argument = spred.argument as acorn.Identifier;
					props['__spread__'+(argument.name || 'unknown')] = { type: 'Any' };
				}
				else {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const c = p as any;
					props[c.key.name || c.key.value] = inferType(p.value);
				}
			}

			return { type: 'Object', properties: props };
		}
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
			return { type: 'Function', returnType: { type: 'Any' } };
		default: return { type: 'Any' };
	}
}
/** -----Infer Type---- */

/** -----Extract export default---- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findExportDefault(node: Node): any {
	if (node.type === 'ExportDefaultDeclaration') {return (node as acorn.ExportDefaultDeclaration).declaration;}
	for (const k in node) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const child = (node as any)[k];
		if (Array.isArray(child)) {
			for (const c of child) {
				const res = findExportDefault(c);
				if (res) {return res;}
			}
		} else if (child && typeof child == 'object') {
			const res = findExportDefault(child);
			if (res) {return res;}
		}
	}
	return null;
}
/** -----Extract export default---- */

/** -----Extract object keys---- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractObjectKeys(objNode: any, propName: string): Record<string, TypeNode> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const prop = objNode.properties.find((p: any) => p.key.name === propName);
	if(!prop) {return {};}
	if (prop.value.type === 'FunctionExpression') {
		const result: Record<string, TypeNode> = {};
		for (const p of prop.value.body.body) {
			console.log('extractObjectKeys::props', p);
			if (p.type === 'ReturnStatement') {
				console.log('extractObjectKeys::ReturnStatement', p);
				const argument = p.argument;
				for (const propertie of argument.properties) {
					if (propertie.type === 'SpreadElement') {
						console.log('extractObjectKeys::SpreadElement', p);
						result['__spread__'+(p.argument.name || 'unknown')] = {type: 'Any' };
					} else {
						console.log('extractObjectKeys::propertie', propertie);
						result[propertie.key.name || propertie.key.value] = inferType(propertie.value);
					}
				}
			}
		}
		return result;
	} else if (prop.value.type === 'ObjectExpression') {
		const result: Record<string, TypeNode> = {};

		for (const p of prop.value.properties) {
			if (p.type === 'SpreadElement') {
				result['__spread__'+(p.argument.name || 'unknown')] = {type: 'Any' };
			} else if (p.value.type === 'FunctionExpression' || p.value.type === 'ArrowFunctionExpression') {
				result[p.key.name || p.key.value] = { type: 'Function', returnType: { type: 'Any' } };
			}
			else {
				result[p.key.name||p.key.value] = inferType(p.value);
			}
		}
		return result;
	}
	return {};
}
/** -----Extract object keys---- */

/** -----Extract hooks using types Vue 2---- */
function extractLifecylceHooksFromTypes(): Record<string, TypeNode> {
	const hooks: Record<string, TypeNode> = {};

	// charger vue/types/vue.d.ts
	const vueTypesPath = require.resolve('vue/types/vue');
	const program = ts.createProgram([vueTypesPath], {allowJs: true});
	const sourceFile = program.getSourceFile(vueTypesPath);
	if (!sourceFile) {return hooks;}

	ts.forEachChild(sourceFile, node => {
		if (ts.isInterfaceDeclaration(node) && node.name.text === 'Vue') {
			node.members.forEach(member => {
				if(ts.isMethodSignature(member) && member.name) {
					if (ts.isIdentifier(member.name)) {
						const name = member.name.text;
						if (
							name.endsWith('Created')
							|| name.endsWith('Mount')
							|| name.endsWith('Update')
							|| name.endsWith('Destroy')
							|| name.endsWith('Activate')
							|| name.endsWith('Deactivate')
						) {
							hooks[name] = { type: 'Function', returnType: { type: 'Any' } };
						}
					}
				}
			});
		}
	});

	return hooks;
}
/** -----Extract hooks using types Vue 2---- */

/** -----Analyze Vue Script---- */
function analyzeVueScript(filePath: string): VueSymbols {
	const content = fs.readFileSync(filePath, 'utf-8');
	const script = parseVueScript(content);
	try {
		const ast = acorn.parse(script, { ecmaVersion: 'latest', sourceType: 'module'});
		const exportNode = findExportDefault(ast);
		if(!exportNode) {return {data: {}, computed: {}, methods: {}, filters: {}, hooks: {}, options: {}};}
		log(`Analyse AST pour ${filePath}`, 'debug');
		return {
			data: extractObjectKeys(exportNode, 'data'),
			computed: extractObjectKeys(exportNode, 'computed'),
			methods: extractObjectKeys(exportNode, 'methods'),
			filters: extractObjectKeys(exportNode, 'filters'),
			hooks: extractLifecylceHooksFromTypes(),
			options: extractObjectKeys(exportNode, 'props'),
		};
	} catch (e) {
		console.log('erreur: ', e);
		return {data: {}, computed: {}, methods: {}, filters: {}, hooks: {}, options: {}};
	}
	
	
}
/** -----Analyze Vue Script---- */

/** -----LSP Setup---- */
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

connection.onInitialize(() => ({ capabilities: { completionProvider: { resolveProvider: false } } }));
connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
	console.log("COMPLETION CALLED");
	const doc = documents.get(params.textDocument.uri);
	if (!doc) {return [];}
	const filePath = doc.uri.replace('file://', '');
	const symbols = analyzeVueScript(filePath);
	console.log("COMPLETION CALLED", symbols);

	const completions: CompletionItem[] = [];

	for (const key in symbols.data) {
		connection.console.log(`${{label: key, kind: CompletionItemKind.Variable, detail: symbols.data[key].type}}`);
		completions.push({label: key, kind: CompletionItemKind.Variable, detail: symbols.data[key].type});
	}
	for (const key in symbols.computed) {
		connection.console.log(`${{label: key, kind: CompletionItemKind.Function, detail: symbols.computed[key].type}}`);
		completions.push({label: key, kind: CompletionItemKind.Function, detail: symbols.computed[key].type});
	}
	for (const key in symbols.methods) {
		connection.console.log(`${{label: key, kind: CompletionItemKind.Method, detail: 'Function'}}`);
		completions.push({label: key, kind: CompletionItemKind.Method, detail: 'Function'});
	}
	for (const key in symbols.filters) {
		connection.console.log(`${{label: key, kind: CompletionItemKind.Function, detail: 'Function'}}`);
		completions.push({label: key, kind: CompletionItemKind.Function, detail: 'Function'});
	}
	for (const key in symbols.hooks) {
		connection.console.log(`${{label: key, kind: CompletionItemKind.Method, detail: 'Function'}}`);
		completions.push({label: key, kind: CompletionItemKind.Method, detail: 'Function'});
	}
	for (const key in symbols.options) {
		connection.console.log(`${{label: key, kind: CompletionItemKind.Property, detail: 'Option'}}`);
		completions.push({label: key, kind: CompletionItemKind.Property, detail: 'Option'});
	}

	return completions;
});

connection.listen();