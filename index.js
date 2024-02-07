import axios from 'axios';
import { Command } from 'commander';
import random from 'random';

const program = new Command();
const BRIDGE_AGENT = "Medusa Bridge:10:https://github.com/the-crypt-keeper"

program
    .option('-c, --cluster-url <url>', 'Set the Horde cluster URL', 'https://stablehorde.net')
    .option('-w, --worker-name <name>', 'Set the Horde worker name', `Automated Instance #${random.int(0, 100000000)}`)
    .option('-a, --api-key <key>', 'Set the Horde API key', '0000000000')
    .option('-s, --server-url <url>', 'Set the REST Server URL', 'http://localhost:8000')
    .requiredOption('-m, --model <model>', 'Set the model name')
    .requiredOption('-x, --ctx <ctx>', 'Set the context length')
    .option('-t, --threads <threads>', 'Number of parallel threads', '2')
    .option('-p, --priority-usernames <usernames>', 'Set priority usernames, comma-separated', (value) => value.split(','), [])
    .parse(process.argv);

const options = program.opts();

console.table(options)
const headers = { 'apikey': options.apiKey };
const cluster = options.clusterUrl;

async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

var failedRequestsInARow = 0;
async function submitGeneration(submitDict) {
    const MAX_SUBMIT_RETRIES = 5;
    let submitRetry = 0;

    while (submitRetry < MAX_SUBMIT_RETRIES) {
        let submitReq;

        try {
            submitReq = await axios.post(`${cluster}/api/v2/generate/text/submit`, submitDict, { headers, timeout: 30000 });
        } catch (error) {
            if (error.response) {
                console.error('submitGeneration() SERVER ERROR', error.response.status, JSON.stringify(error.response.data))
                break;
            } else {
                console.error('submitGeneration() CONNECT ERROR', JSON.stringify(error))
                await sleep(10000);
                submitRetry++;
                continue;
            }
        }

        let reward;
        try {
            reward = submitReq.data.reward;
        } catch (error) {
            console.error('submitGeneration() PARSE ERROR', JSON.stringify(error), JSON.stringify(submitReq.data));
            await sleep(10000);
            submitRetry++;
            continue;
        }
        
        console.info(`Submitted ${submitDict.id} and contributed for ${reward.toFixed(2)}`);
        failedRequestsInARow = 0;
        break;
    }

}

var lastRetrieved = null;
var lastStatus = null;
async function validateServer() {
    const kaiUrl = options.serverUrl;
    if (lastStatus != null && (Date.now() - lastRetrieved) <= 30000) {
        return lastStatus;
    }
    lastRetrieved = Date.now();
    console.debug("Retrieving settings from API Server...");

    try {
        const req = await axios.get(`${kaiUrl}/health`);
        if (req.status === 200) {
            lastStatus = true;
        } else {
            console.error(`Health check failed with status {req.status}`);
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.error(`Server ${kaiUrl} is up but does not appear to be a VLLM server.`);
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            console.error(`Server ${kaiUrl} is not reachable. Are you sure it's running?`);
        } else {
            console.error(error);
        }
        lastStatus = false;
    }
    return lastStatus;
}

async function completionServer(request) {
    const kaiUrl = options.serverUrl;

    try {
        const req = await axios.post(`${kaiUrl}/generate`, request);
        return req.data.text[0];
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.error(`Server ${kaiUrl} is up but does not appear to be a VLLM server.`);
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            console.error(`Server ${kaiUrl} is not reachable. Are you sure it's running?`);
        } else {
            console.error(error);
        }
    }
    return false;
}

async function textGenerationJob() {
    let currentId = null;
    let currentPayload = null;
    const interval = 10000;

    // Make sure generation server is alive
    let server_ok = await validateServer();
    if (server_ok !== true) {
        await sleep(interval);
        return false;
    }

    // Generate pop request
    const genDict = {
        name: options.workerName,
        models: ['vllm/'+options.model],
        max_length: parseInt(options.ctx)/2,
        max_context_length: parseInt(options.ctx),
        priority_usernames: options.priorityUsernames,
        softprompts: [],
        bridge_agent: BRIDGE_AGENT
    };
    // console.log(genDict);    

    // Pop a generation
    let loopRetry = 0;    
    const retries = 3;
    while (loopRetry < retries) {
        let popReq;
        try {
            popReq = await axios.post(`${cluster}/api/v2/generate/text/pop`, genDict, { timeout: 40000, headers: headers });
        } catch (error) {
            if (error.response) {
                console.error('textGenerationJob() SERVER ERROR', error.response.status, JSON.stringify(error.response.data))
                await sleep(interval);
                return false; // HARD FAIL
            } else {
                console.error('textGenerationJob() CONNECT ERROR', JSON.stringify(error))
                await sleep(interval);
                loopRetry++;
                continue;
            }
        }

        try {
            currentId = popReq.data.id;
            currentPayload = popReq.data.payload;
        } catch (error) {
            console.error('textGenerationJob() PARSE ERROR', JSON.stringify(error), JSON.stringify(popReq.data));
            await sleep(interval);
            loopRetry++;
            continue;
        }

        if (!currentId) {
            console.debug(`Server ${cluster} has no valid generations to do for us. Skipped Info: ${popReq.data.skipped}.`);
            await sleep(interval);
            continue;
        }

        if ('width' in currentPayload || 'length' in currentPayload || 'steps' in currentPayload) {
            console.warning(`Stable Horde payload detected: ${currentPayload}. Aborting.`);
            currentId = null;
            continue;
        }

        if (!currentPayload.max_length) { currentPayload.max_length = 80; }
        if (!currentPayload.max_context_length) { currentPayload.max_context_length = 1024; }

        console.info(`New job received from ${cluster} for ${currentPayload.max_length} tokens and ${currentPayload.max_context_length} max context.`);
        break;
    }

    // Handle pop failure
    if (!currentId) {
        return false;
    }

    // Convert to VLLM parameters
    if (currentPayload.top_k == 0) { currentPayload.top_k = -1; }
    const vllm_request = {
        'prompt': currentPayload.prompt,
        'stop': currentPayload.stop_sequence ?? [],
        'max_tokens': currentPayload.max_length,
        'temperature': currentPayload.temperature ?? 1.0,
        'top_k': currentPayload.top_k ?? -1,
        'top_p': currentPayload.top_p ?? 1.0,
        'repetition_penalty': currentPayload.rep_pen ?? 1.0
    }

    // Generate with retry
    loopRetry = 0;
    while (loopRetry < retries) {
        const gen_req = await completionServer(vllm_request);

        if (gen_req === false) {
            console.error('Generation problem, will try again...')
            loopRetry++;
            await sleep(interval);
            continue;
        }

        // Generate OK - submit it.
        submitGeneration({"id": currentId, "generation": gen_req});
        currentId = null;
        break;
    }

    // Handle generate failure
    if (currentId !== null) {
        const fail_dict = {
            "id": currentId,
            "state": "faulted",
            "generation": "faulted",
            "seed": -1,
        }
        
        try {
            const failure_req = await axios.post(`${cluster}/api/v2/generate/text/submit`, fail_dict, { timeout: 40000, headers: headers });
        } catch (error) {
            if (error.response) {
                console.error('textGenerationJob() FAIL SERVER ERROR', error.response.status, JSON.stringify(error.response.data))
            } else {
                console.error('textGenerationJob() FAIL CONNECT ERROR', JSON.stringify(error))
            }
        }

        return false;
    }

    // Done.
    return true;
}

// console.log(await validateServer());
// console.log(await completionServer({'prompt': 'What is the capital of France?'}))
let running = true;
process.on('SIGINT', async function() {
    console.log("Caught interrupt signal");
    running = false;
});
process.on('uncaughtException', function(err) { 
    console.log("Caught unexpected exception", err);
    running = false;
}) 
process.on('uncaughtRejection', function(err) { 
    console.log("Caught unexpected rejection", err);
    running = false;
}) 

async function runThread(t) { 
    let startTime = Date.now(); // Record the start time
    while (running) {
        let res;
        try {
            res = await textGenerationJob();
        } catch(error) {
            console.error('Thread',t,'FAILED: ', JSON.stringify(error));
            res = null;
        }

        let endTime = Date.now(); // Record the end time
        let runtime = endTime - startTime;
        console.log("Thread",t,"iteration time", runtime, "ms", "result", res);
        startTime = endTime; // Update the start time for the next iteration

        if (res !== true) {
            failedRequestsInARow++;
            if (failedRequestsInARow == 3) {
                console.error('Failed too many requests in a row, aborting bridge...');
                running = false;
            }
        }
    }
    console.log('Thread',t,'shutting down.')
}

const THREADS = parseInt(options.threads);
console.log(`Spawning ${THREADS} worker threads.`)
for (let t=0; t<THREADS; t++) {
    runThread(t);
}

console.log('Press <Ctrl+C> to exit ...')