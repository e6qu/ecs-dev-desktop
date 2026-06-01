// SPDX-License-Identifier: AGPL-3.0-or-later
import { FakeStorageProvider } from "./fake-storage-provider";
import { storageProviderContract } from "./storage-provider-contract";

storageProviderContract("FakeStorageProvider", () => FakeStorageProvider.create());
