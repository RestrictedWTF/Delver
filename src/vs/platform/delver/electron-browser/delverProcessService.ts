/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDelverProcessService } from '../common/delverProcessService.js';
import { registerSharedProcessRemoteService } from '../../ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IDelverProcessService, 'delver');
