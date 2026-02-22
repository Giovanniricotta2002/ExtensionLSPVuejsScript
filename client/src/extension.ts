/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

	const config = workspace.getConfiguration('vue2LSP');
	const logLevel = config.get<string>('logLevel', 'info');

	const serverOptions: ServerOptions = {
		run: {module: serverModule, transport: TransportKind.ipc, args: [`--log-level=${logLevel}`]},
		debug: {module: serverModule, transport: TransportKind.ipc, args: [`--log-level=${logLevel}`]}
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{scheme: 'file', language: 'vue'}],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*.vue')
		}
	};

	client = new LanguageClient('vue2LSP', 'Custom VueJs Vuetify 2 LSP', serverOptions, clientOptions);
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
