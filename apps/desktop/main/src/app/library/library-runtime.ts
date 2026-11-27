import { app, dialog, ipcMain, utilityProcess, powerMonitor,shell } from "electron";
import { join } from "path";
import { pathToFileURL } from "url";
import { windows } from "../windows";
import { environment } from "../../environments/environment";
import { LIBRARY_CHANGED_CHANNEL, LIBRARY_DEMAND_CHANNEL, LIBRARY_REQUEST_CHANNEL } from "../../../../shared/replay-library";
import { LibraryMainOwner } from "./library-main-owner";
import { LibraryProcessClient } from "./library-process-client";
import { assertLibrarySender, LibraryMainApi } from "./library-ipc";
import { readNativePreference, saveNativePreference } from "./library-native-preference";
import { LazerSource } from "./sources/lazer-source";
import { LIBRARY_RESOURCE_CHANNEL } from "../../../../shared/library-resources";
import { REPLAY_SOURCE_FILE } from "../replay-source";
import { LibraryResourceApi } from "./library-resource-ipc";
import { LibraryReplayOpener } from "./library-replay-opener";
import type { LibraryResourceOperation, LibraryResourceConfiguration } from "./library-resource-server";
import { LibraryAnalysisOwner } from "./library-analysis-owner";
import { LibraryNativeBroker } from "./library-native-admission";
import { LibraryNumericalResources } from "./library-numerical-resources";
import { startLibraryNumericalExecution, LibraryNumericalExecutionDependencies } from "./library-numerical-execution";
import { startLibraryNumericalPreparation } from "./library-numerical-preparation";
import { startLibraryPerformancePreparation } from "./library-performance-preparation";
import { createLibraryAnalysisUtilityPort } from "./library-analysis-utility-client";
import { startLibraryNumerical } from "../../../../frontend/src/app/services/library/library-analysis-client";
import { LibraryChangeRelay } from "./library-change-relay";
import { LibraryCurrentReplayBridge } from "./library-current-replay-bridge";
import { LibraryPassiveResources } from "./library-passive-resources";
import { LibraryArtworkCache } from "./library-artwork-cache";
import { LibraryPassiveResourceApi } from "./library-passive-resource-api";
import { createLibraryPassiveSelector } from "./library-passive-selector";
import { LIBRARY_PASSIVE_RESOURCE_CHANNEL } from "../../../../shared/library-passive-resources";
import { createLibraryAnalysisDiagnostics } from "./library-analysis-diagnostics";
import type { LibraryAnalysisWorkerPort } from "../../../../frontend/src/app/services/library/library-analysis-client";
import { sparseEnabled,sparsePreparation } from "./library-sparse-observation";
import type { LibraryPreparationTicket } from "./library-preparation-store";
import { LibrarySourceMutationFence } from "./library-source-mutation";
import { LibraryDeletionResourceOwner } from "./library-source-deletion-resource-bridge";
import { inspectLibraryProcessIdentity,pinLibraryProcessIdentity } from "./library-source-process-identity";

/** Registration is eager; app paths, persistent storage and the child are acquired only on use. */
export function registerLibraryRuntime(nativeExecutable: () => string): { close(): Promise<void> } {
  const diagnostics=createLibraryAnalysisDiagnostics(process.env.HINDSIGHT_LIBRARY_CONTROL_TRACE);
  const nativeUncertainty:{error?:Error}={};
  const changes=new LibraryChangeRelay();
  let api: LibraryMainApi | undefined, closed = false, observed: Electron.WebContents | undefined;
  let resources: LibraryResourceApi | undefined;
  let currentReplay:LibraryCurrentReplayBridge|undefined;
  let passive:LibraryPassiveResourceApi|undefined,libraryNativeBroker:LibraryNativeBroker|undefined;
  let analysis:LibraryAnalysisOwner|undefined,powerObserved=false;
  const sourceMutation=new LibrarySourceMutationFence({
    busy:()=>closed||!analysis||api?.sourceConfigurationBusy===true,
    drain:async()=>{
      const results=await Promise.allSettled([analysis?.setSourceMutationHold(true),passive?.releaseDocument()]);
      const failed=results.find(result=>result.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
    },
    release:async()=>{await analysis?.setSourceMutationHold(false);},
  });
  const battery=()=>{if(!closed)void analysis?.setOnBattery(true).catch(error=>console.error("Could not pause library on battery",error));};
  const mains=()=>{if(!closed)void analysis?.setOnBattery(false).catch(error=>console.error("Could not resume library on AC",error));};
  const expectedUrl = process.env.ELECTRON_IS_DEV || !environment.production
    ? "http://localhost:4200/" : pathToFileURL(join(__dirname, "frontend", "index.html")).href;
  const current = (event: Electron.IpcMainInvokeEvent) => assertLibrarySender(event, windows.frontend?.webContents, expectedUrl);
  const observe = () => {
    const sender = windows.frontend?.webContents;
    if (!sender || observed === sender) return; observed = sender;
    changes.attach(event=>{if(!closed&&!sender.isDestroyed()&&windows.frontend?.webContents===sender)sender.send(LIBRARY_CHANGED_CHANNEL,event);});
    const hold = () => {
      if (closed) return;
      void api?.holdDocument().catch(error => console.error("Could not hold library after renderer left", error));
      void resources?.releaseDocument().catch(error => console.error("Could not release library document resources", error));
      void currentReplay?.releaseDocument().catch(error=>console.error("Could not release current replay publication",error));
      void passive?.releaseDocument().catch(error=>console.error("Could not release passive library resources",error));
    };
    sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) hold(); });
    sender.on("render-process-gone", hold); sender.once("destroyed", hold);
    sender.on("did-finish-load",()=>{if(observed===sender)changes.snapshot();});
  };
  const get = () => {
    if (closed) throw new Error("Library runtime is closed");
    if (!app.isReady()) throw new Error("Application is not ready");
    if (api) { observe(); return api; }
    const directory = join(app.getPath("userData"), "library");
    const owner = new LibraryMainOwner({ directory, appData: app.getPath("appData"), nativeExecutable: nativeExecutable(), originFile: join(app.getPath("userData"), REPLAY_SOURCE_FILE) },
      config => {
        const deletionResources=new LibraryDeletionResourceOwner(config.directory,config.sources,(ownerId,retiredOwnerIds)=>
          new LibraryProcessClient<LibraryResourceOperation,LibraryResourceConfiguration>(
            ()=>utilityProcess.fork(join(__dirname,"library-resource-utility.js"),[],{serviceName:"Hindsight Source Preparation",stdio:"ignore"}),
            {nativeExecutable:config.nativeExecutable,originFile:config.originFile as string,background:true,deletionAppDirectory:config.directory,deletionStageOwnerId:ownerId,deletionRetiredStageOwnerIds:retiredOwnerIds},
            {foreground:true,configureProcess:async(pid,configuration)=>({...configuration,deletionStageOwnerProcess:await pinLibraryProcessIdentity(config.nativeExecutable,pid)})}),
          pid=>inspectLibraryProcessIdentity(config.nativeExecutable,pid));
        const nativeBroker=new LibraryNativeBroker(nativeUncertainty,8,sourceMutation,deletionResources);
        libraryNativeBroker=nativeBroker;
        void currentReplay?.releaseDocument().catch(error=>console.error("Could not retire current replay publication",error));
        const metadata=new LibraryProcessClient(()=>utilityProcess.fork(join(__dirname,"library-utility.js"),[],{serviceName:"Hindsight Library",stdio:"ignore"}),{...config,nativeAdmission:true},{nativeBroker,sourceMutation:true});
        metadata.onLibraryChanged(changes.beginSource());
        const resourceClient=(preparation?:LibraryPreparationTicket)=>new LibraryProcessClient<LibraryResourceOperation,LibraryResourceConfiguration>(
              ()=>utilityProcess.fork(join(__dirname,"library-resource-utility.js"),[],{serviceName:"Hindsight Library Analysis Resources",stdio:"ignore"}),
              {nativeExecutable:config.nativeExecutable,originFile:config.originFile as string,background:true,nativeAdmission:true,
                ...(sparseEnabled&&preparation?{sparsePreparation:sparsePreparation(preparation)}:{})},{foreground:true,nativeBroker});
        const resources=()=>new LibraryNumericalResources({metadata:(method,args)=>metadata.request(method,args),resources:resourceClient()});
        const startWorker:LibraryNumericalExecutionDependencies["startWorker"]=(target,input,control,cancellation,read,publish,publishTimeline,publishFc)=>{
          const spawn=(args:string[])=>utilityProcess.fork(join(__dirname,"library-analysis-utility.js"),args,{serviceName:"Hindsight Library Analysis",stdio:"ignore"});
          const start=(factory:()=>LibraryAnalysisWorkerPort)=>startLibraryNumerical(target,input,control,cancellation,factory,read,publish,publishTimeline,publishFc);
          return diagnostics?diagnostics.start(target,spawn,nativeBroker,config.nativeExecutable as string,start):
            start(()=>createLibraryAnalysisUtilityPort(()=>spawn([]),{nativeBroker,nativeExecutable:config.nativeExecutable as string}));
        };
        const currentAnalysis=new LibraryAnalysisOwner(metadata,(ticket,initial,signal)=>startLibraryNumericalExecution(ticket,initial,signal,{resources:resources(),startWorker,
          metadata:(method,args)=>metadata.request(method,args)}),150,
          {availableSlots:["numerical","timeline-pp","fc-pp"],statusChanged:()=>changes.snapshot(true),nativeDemand:active=>nativeBroker.setViewerDemand(active),nativeCapacity:capacity=>nativeBroker.setCapacity(capacity),closeOwned:()=>nativeBroker.close(),preparation:{stages:["P","S"],
            start:(ticket,initial,signal)=>ticket.stage==="P"
              ?startLibraryPerformancePreparation(ticket,initial,signal,{resources:resourceClient(ticket),metadata:(method,args)=>metadata.request(method,args)})
              :startLibraryNumericalPreparation(ticket,initial,signal,{resources:resources(),startWorker,timeline:true,metadata:(method,args)=>metadata.request(method,args)})}});
        analysis=currentAnalysis;
        if(!powerObserved){powerObserved=true;powerMonitor.on("on-battery",battery);powerMonitor.on("on-ac",mains);}
        void currentAnalysis.setOnBattery(powerMonitor.isOnBatteryPower()).catch(error=>console.error("Could not initialize library power state",error));
        return currentAnalysis;
      });
    // Fail closed until the renderer publishes its current viewer/export/capture demand.
    void owner.setViewerDemand(true, "document-unavailable");
    const native = new LazerSource(nativeExecutable);
    const resourceClient = new LibraryProcessClient<LibraryResourceOperation, LibraryResourceConfiguration>(
      () => utilityProcess.fork(join(__dirname, "library-resource-utility.js"), [], { serviceName: "Hindsight Replay Resources", stdio: "ignore" }),
      { nativeExecutable: nativeExecutable(), originFile: join(app.getPath("userData"), REPLAY_SOURCE_FILE) }, { foreground: true });
    currentReplay=new LibraryCurrentReplayBridge((method,args,assertCurrent)=>owner.request(method,args,assertCurrent));
    const artworkCache=new LibraryArtworkCache({directory:join(directory,"artwork-cache")});
    const passiveSelector=createLibraryPassiveSelector({artworkCache,metadata:(method,args)=>owner.request(method,args),createNative:()=>{
      if(!libraryNativeBroker)throw new Error("Library native resources are not configured");
      return new LibraryProcessClient<LibraryResourceOperation,LibraryResourceConfiguration>(
        ()=>utilityProcess.fork(join(__dirname,"library-resource-utility.js"),[],{serviceName:"Hindsight Library Artwork Resources",stdio:"ignore"}),
        {nativeExecutable:nativeExecutable(),originFile:join(app.getPath("userData"),REPLAY_SOURCE_FILE),background:true,nativeAdmission:true},
        {foreground:true,nativeBroker:libraryNativeBroker,nativePriority:"artwork"});
    }});
    passive=new LibraryPassiveResourceApi(new LibraryPassiveResources(passiveSelector,artworkCache),path=>shell.showItemInFolder(path));
    resources = new LibraryResourceApi(new LibraryReplayOpener({ metadata: (method, args) => owner.request(method, args), resources: resourceClient,
      currentReplay:{bind:(input,assertCurrent)=>currentReplay!.bind(input,assertCurrent),release:receipt=>currentReplay!.release(receipt)} }));
    api = new LibraryMainApi({ owner,
      sourceMutationHeld:()=>sourceMutation.held,
      receiveCurrentReplay:(value,assertCurrent)=>currentReplay!.receive(value,assertCurrent),
      readNativeDirectory: () => readNativePreference(directory), saveNativeDirectory: value => saveNativePreference(directory, value),
      inspectNative: (value, signal) => native.inspect(value, signal),
      closeNative: () => native.close(),
      pickImports: async () => {
        const parent = windows.frontend; if (!parent) throw new Error("Replay window is closed");
        const result = await dialog.showOpenDialog(parent, { title: "Import replays", properties: ["openFile", "multiSelections"], filters: [{ name: "osu! Replay", extensions: ["osr"] }] });
        return result.canceled ? null : result.filePaths;
      },
      pickNative: async () => {
        const parent = windows.frontend; if (!parent) throw new Error("Replay window is closed");
        const result = await dialog.showOpenDialog(parent, { title: "Locate osu!lazer installation", properties: ["openDirectory"], defaultPath: join(app.getPath("appData"), "osu") });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
    });
    observe(); return api;
  };
  ipcMain.handle(LIBRARY_REQUEST_CHANNEL, (event, value) => { current(event); return get().receive(value, () => current(event)); });
  ipcMain.handle(LIBRARY_DEMAND_CHANNEL, async(event, value) => {
    current(event);const demand=get().demand(value);
    await Promise.all([demand,...(value===true?[passive?.releaseDocument()]:[])]);
  });
  ipcMain.handle(LIBRARY_PASSIVE_RESOURCE_CHANNEL,(event,value)=>{
    current(event);
    // A closing instance still owns releases; never create an instance after close.
    if(!closed)get();if(!passive)throw new Error("Passive library resources are unavailable");
    if(!value||value.method!=="release")sourceMutation.assertReadable();
    return passive.receive(value,()=>current(event));
  });
  ipcMain.handle(LIBRARY_RESOURCE_CHANNEL, (event, value) => {
    current(event); get();
    if (!resources) throw new Error("Library resources are unavailable");
    const receive=()=>resources!.receive(value,()=>current(event));
    return value?.method==="release"?receive():sourceMutation.read(receive);
  });
  return { close: async () => {
    closed = true;
    changes.close();
    if(powerObserved){powerMonitor.removeListener("on-battery",battery);powerMonitor.removeListener("on-ac",mains);}
    // Foreground opens may still be binding a lease. Drain them, then revoke capabilities
    // before the metadata process is retired. Every close still runs if an earlier one fails.
    const results:PromiseSettledResult<unknown>[]=[];
    // The metadata utility owns dispatched source writes. Revoke only at recorded boundaries
    // and await helper exit before its ordinary process-client close deadline may start.
    results.push(...await Promise.allSettled([libraryNativeBroker?.drainMutation()]));
    results.push(...await Promise.allSettled([resources?.close(),passive?.close()]));
    results.push(...await Promise.allSettled([currentReplay?.close()]));
    results.push(...await Promise.allSettled([api?.close()]));
    // Diagnostic output is best effort and never extends the application's ownership fence.
    void diagnostics?.close();
    const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
  } };
}
