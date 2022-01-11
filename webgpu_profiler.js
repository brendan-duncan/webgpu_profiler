class WebGPUProfiler {
// public:
    constructor(options) {
        console.log("WebGPU Profiler");
        if (!navigator.gpu)
            return;

        this._frames = [];
        this._currentFrame = null;
        this._frameIndex = -1;
        this._isRecording = false;
        this._initalized = true;
        this._objectID = 1;
        this._frameStartTime = -1;
        this._timeSinceLastFrame = 0;
        this._maxFramesToRecord = 1000;
        this._recordRequest = false;

        this._wrapObject(navigator.gpu);
        this._wrapCanvases();

        let self = this;

        // Capture any dynamically created canvases
        let __createElement = document.createElement;
        document.createElement = function(type) {
            let element = __createElement.call(document, type);
            if (type == "canvas") {
                self._wrapCanvas(element);
            }
            return element;
        };

        // Wrap requestAnimationFrame so it can keep track of per-frame recording and know when
        // the maximum number of frames has been reached.
        //
        // It would be nice to be able to arbitrarily start/stop recording. To do this,
        // we would need to keep track of things like shader creation/deletion that can happen
        // at arbitrary frames prior to the start, for any objects used within that recorded
        // duration.
        let __requestAnimationFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = function(cb) {
            function callback() {
                self._frameStart();
                cb(performance.now());
                self._frameEnd();
            }
            __requestAnimationFrame(callback);
        };

        if (options && options.recordOnStart)
            this.startRecord();

        this._initializeUI();
    }

    startRecord() {
        this.clear();
        this._recordRequest = true;
    }

    stopRecord() {
        this._recordRequest = false;
        this._isRecording = false;
    }

    get isRecording() { return this._isRecording; }

    clear() {
        this._frames.length = 0;
        this._currentFrame = null;
        this._frameIndex = 0;
    }

    generateReport() {
        let self = this;
        let debuggerWindow = window.open("webgpu_profiler.html","WebGPU Profiler",`width=${screen.width-60},height=${screen.height-200},left=30,top=30,menubar=0,toolbar=0,status=0,location=0`);
        window.addEventListener("beforeunload", () => {
            debuggerWindow.close();
            delete self.debuggerWindow;
        });
    
        debuggerWindow.onload = () => {
            self.debuggerWindow = debuggerWindow;
            self.debuggerWindow.webgpuProfiler = self;

            self.debuggerWindow.document.getElementById('frameList').innerHTML = '';
            for (let i = 0; i < self._frames.length; ++i) {
                self._populateFrameNumber(i);
            }
            self._printFrameTrace(self._frameIndex);
        };
    }

    _populateFrameNumber(frameNum) {
        if (frameNum > this._maxFramesToRecord) return;
        if (this.debuggerWindow) {
            let doc = this.debuggerWindow.document;
            let currentFrame = this._frames[frameNum];
            let frameNumber = doc.getElementById('frameList');
            let el = doc.createElement('div');

            let s;
            if (frameNum < (this._frames.length - 1)) {
                let nextFrame = this._frames[frameNum + 1];
                if (nextFrame.timeSinceLastFrame > 50)
                    s = `<span class="slowFrame">Frame: ${frameNum} Time: ${currentFrame.duration.toFixed(2)} / ${nextFrame.timeSinceLastFrame.toFixed(2)}</span>`;
                else 
                    s = `Frame: ${frameNum} Time: ${currentFrame.duration.toFixed(2)} / ${nextFrame.timeSinceLastFrame.toFixed(2)}`;
            }

            if (!s)
                s = `Frame: ${frameNum} Time: ${currentFrame.duration.toFixed(2)}`;

            el.innerHTML = s;

            frameNumber.appendChild(el);

            const self = this;
            el.onclick = () => {
                self._printFrameTrace(frameNum);
            };
        }
    }

    _printFrameTrace(frameNumber) {
        frameNumber = Math.min(frameNumber, this._frames.length - 2);
        let doc = this.debuggerWindow.document;
        let frameTrace = doc.getElementById('commandList');
        let currentFrame = this._frames[frameNumber];
        if (!currentFrame) return;
        frameTrace.innerHTML = '';
        
        let div = doc.createElement("div");
        div.classList.add("frameTitle");
        div.innerHTML = `FRAME ${frameNumber}`;
        frameTrace.appendChild(div);

        let currentPass = frameTrace;

        let callNumber = 1;
        currentFrame.commands.forEach((call) => {
            let objClass = call[0];
            let objId = call[1];
            let method = call[2];
            let args = this._stringifyArgs(call[4][0]);

            if (method == "beginRenderPass") {
                currentPass = doc.createElement("div");
                currentPass.classList = "renderpass";
                frameTrace.appendChild(currentPass);
            } else if (method == "beginComputePass") {
                currentPass = doc.createElement("div");
                currentPass.classList = "computepass";
                frameTrace.appendChild(currentPass);
            }

            let div = doc.createElement("div");

            if (WebGPUProfiler._slowMethods.indexOf(method) != -1)
                div.classList.add("createMethod");

            div.innerHTML = `<span class='callnum'>${callNumber++}.</span> <span class='objectName'>${objClass}@${objId}</span>.<span class='functionName'>${method}</span>(<span class='functionArgs'>${args}</span>)`;

            currentPass.appendChild(div);

            if (method == "endPass")
                currentPass = frameTrace;
        });
    }

// private:
    _initializeUI() {
        let button = document.createElement("button");
        button.innerText = this.isRecording ? "Stop Record" : "Start Record";
        document.body.appendChild(button);
        let self = this;
        button.onclick = () => {
            if (self.isRecording) {
                self.stopRecord();
                button.innerText = "Start Record";
                self.generateReport();
            } else {
                self.startRecord();
                button.innerText = "Stop Record";
            }
        };
    }

    _frameStart() {
        if (this._recordRequest) {
            this._recordRequest = false;
            this._isRecording = true;
        }

        if (this._isRecording) {
            let time = performance.now();
            if (this._frameStartTime != -1)
                this._timeSinceLastFrame = time - this._frameStartTime;
            this._frameStartTime = time;
            this._frameIndex++;
            this._currentFrame = [];
        }
    }

    _frameEnd() {
        if (this._isRecording) {
            let time = performance.now();
            let duration = time - this._frameStartTime;
            this._frames.push({timeSinceLastFrame: this._timeSinceLastFrame, duration, commands: Array.from(this._currentFrame)});
        }
    }

    _stringifyArgs(args, writeKeys=false) {
        let s = "";
        for (let key in args) {
            let a = args[key];
            if (s != "")
                s += ", ";

            if (writeKeys)
                s += `"${key}":`;

            if (!a)
                s += a;
            else if (typeof(a) == "string")
                s += `\`${a}\``;
            else if (a.length && a.length > 10)
                s += `${a.constructor.name}(${a.length})`;
            else if (a.length !== undefined)
                s += `[${this._stringifyArgs(a, false)}]`;
            else if (a.__id !== undefined)
                s += `${a.constructor.name}@${a.__id}`;
            else if (typeof(a) == "object")
                s += `{ ${this._stringifyArgs(a, true)} }`;
            else
                s += JSON.stringify(a);
        }
        return s;
    }

    _downloadFile(data, filename) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([data], {type: 'application/javascript'}));
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    _wrapCanvas(c) {
        if (c.__id)
            return;
        c.__id = this._objectID++;
        let self = this;
        let __getContext = c.getContext;

        c.getContext = function(a1, a2) {
            let ret = __getContext.call(c, a1, a2);
            if (a1 == 'webgpu') {
                if (ret) {
                    self._wrapObject(ret);
                }
            }
            return ret;
        };
    }

    _wrapCanvases() {
        let canvases = document.getElementsByTagName('canvas');
        for (let i = 0; i < canvases.length; ++i) {
            let c = canvases[i];
            this._wrapCanvas(c);
        }
    }

    _objectHasMethods(object) {
        for (let m in object) {
            if (typeof(object[m]) == "function" && WebGPUProfiler._skipMethods.indexOf(m) == -1) {
                return true;
            }
        }
        return false;
    }

    _wrapObject(object) {
        if (object.__id)
            return;
        object.__id = this._objectID++;

        for (let m in object) {
            if (typeof(object[m]) == "function") {
                if (WebGPUProfiler._skipMethods.indexOf(m) == -1) {
                    if (WebGPUProfiler._asyncMethods.indexOf(m) != -1)
                        this._wrapAsync(object, m);
                    else
                        this._wrapMethod(object, m);
                }
            } else if (typeof(object[m]) == "object") {
                let o = object[m];
                if (!o || o.__id)
                    continue;
                let hasMethod = this._objectHasMethods(o);
                if (!o.__id && hasMethod) {
                    this._wrapObject(o);
                }
            }
        }
    }

    _wrapMethod(object, method) {
        if (WebGPUProfiler._skipMethods.indexOf(method) != -1)
            return;
        let origMethod = object[method];
        let self = this;

        object[method] = function() {
            let t0 = performance.now();
            let result = origMethod.call(object, ...arguments);
            let t1 = performance.now();
            if (result && typeof(result) == "object")
                self._wrapObject(result);
            if (self._isRecording)
                self._recordCommand(object, method, result, t1 - t0, arguments);
            return result;
        };
    }

    _wrapAsync(object, method) {
        let origMethod = object[method];
        let self = this;
        object[method] = function() {
            let t0 = performance.now();
            let id = this._objectID++;
            let promise = origMethod.call(object, ...arguments);
            if (this._isRecording)
                this._recordAsyncCommand(object, method, id, arguments);
            let wrappedPromise = new Promise((resolve) => {
                promise.then((result) => {
                    let t1 = performance.now();
                    if (self._isRecording)
                        self._resolveAsyncCommand(id, t1 - t0, result);
                    if (result && result.__id) {
                        resolve(result);
                        return;
                    }
                    if (result && typeof(result) == "object")
                        self._wrapObject(result);
                    resolve(result);
                });
            });
            return wrappedPromise;
        };
    }

    _recordCommand(object, method, result, time, ...args) {
        this._currentFrame.push([object.constructor.name, object.__id, method, time, args])
    }

    _recordAsyncCommand(object, method, id, ...args) {
        console.log("ASYNC", method, id);
    }

    _resolveAsyncCommand(id, time, result) {
        console.log("RESOLVE", id, time);
    }
}

WebGPUProfiler._slowMethods = [
    "createBuffer",
    "createBindGroup",
    "createShaderModule",
    "createRenderPipeline",
    "createComputePipeline",
];

WebGPUProfiler._asyncMethods = [
    "requestAdapter",
    "requestDevice",
    "createComputePipelineAsync",
    "createRenderPipelineAsync"
];

WebGPUProfiler._skipMethods = [
    "toString",
    "entries",
    "getContext",
    "forEach",
    "has",
    "keys",
    "values",
    "getPreferredFormat",
    "pushErrorScope",
    "popErrorScope"
];
