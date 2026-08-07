/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDelverAnalysisService } from '../common/delverAnalysisService.js';
import { registerSharedProcessRemoteService } from '../../ipc/electron-browser/services.js';

registerSharedProcessRemoteService(IDelverAnalysisService, 'delverAnalysis');
