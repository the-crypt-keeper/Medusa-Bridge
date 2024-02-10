import fs from 'fs';
import axios from 'axios';
import { Command } from 'commander';
import random from 'random';
import winston from 'winston';
const { combine, timestamp, cli, json } = winston.format;

const logger = winston.createLogger({
    level: 'debug',
    format: combine(timestamp(), json()),
    transports: [new winston.transports.Console({format: cli()}), new winston.transports.File({filename: 'medusa.log', level: 'error'})],
});

const program = new Command();
const BRIDGE_AGENT = "Medusa Bridge:10:https://github.com/the-crypt-keeper"

program
    .option('-f, --config-file <file>', 'Load config from .json file')
    .option('-c, --cluster-url <url>', 'Set the Horde cluster URL', 'https://stablehorde.net')
    .option('-w, --worker-name <name>', 'Set the Horde worker name', `Automated Instance #${random.int(0, 100000000)}`)
    .option('-a, --api-key <key>', 'Set the Horde API key', '0000000000')
    .option('-s, --server-url <url>', 'Set the REST Server URL', 'http://localhost:8000')
    .option('-t, --server-type <type>', 'Set the REST Server type', 'vllm')
    .option('-m, --model <model>', 'Set the model name')
    .option('-x, --ctx <ctx>', 'Set the context length')
    .option('-t, --threads <threads>', 'Number of parallel threads', '1')
    .option('-p, --priority-usernames <usernames>', 'Set priority usernames, comma-separated', (value) => value.split(','), [])
    .parse(process.argv);

const options = program.opts();

// Load configuration from file if --config-file is provided
if (options.configFile) {
    const configFile = options.configFile;
    try {
        const configOptions = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        Object.keys(configOptions).forEach(key => {
            if (program.getOptionValueSource(key) === 'default') {
                program.setOptionValueWithSource(key, configOptions[key], 'config');
            }
        });
    } catch (error) {
        logger.error(`Error loading config file: ${error.message}`);
        process.exit(1);
    }
}

// Re-assign options after loading config file
const options = program.opts();

logger.info("Starting with options:", options)
console.table(options)

const headers = { 'apikey': options.apiKey };
const cluster = options.clusterUrl;

async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}

async function safePost(url, body) {
    let resp;

    try {
        resp = await axios.post(url, body, { headers, timeout: 30000 });
        resp.ok = true;
    } catch (error) {
        if (error.response) {
            logger.error(`safePost() SERVER ERROR ${error.response.status}`, { 'response': error.response, 'url': url, 'body': body })
            if (error.response.data) { logger.error(JSON.stringify(error.response.data)); }
            resp = error.response;
            resp.ok = false;
        } else {
            logger.error('safePost() CONNECT ERROR', { 'error': error, 'url': url, 'body': body  })
            resp = { 'ok': false, 'error': error }
        }
    }

    return resp;
}

var failedRequestsInARow = 0;
async function submitGeneration(submitDict) {
    const MAX_SUBMIT_RETRIES = 5;
    let submitRetry = 0;

    while (submitRetry < MAX_SUBMIT_RETRIES) {
        let submitReq = await safePost(`${cluster}/api/v2/generate/text/submit`, submitDict);
        if (!submitReq.ok) {
            await sleep(10000);
            submitRetry++;
            continue;
        }

        let reward;
        try {
            reward = submitReq.data.reward;
        } catch (error) {
            logger.error('submitGeneration() PARSE ERROR', JSON.stringify(error), JSON.stringify(submitReq.data));
            await sleep(10000);
            submitRetry++;
            continue;
        }
        
        logger.info(`Submitted ${submitDict.id} and contributed for ${reward.toFixed(2)}`);
        failedRequestsInARow = 0;
        break;
    }

}

// let healthUrl = `${options.serverUrl}/health`;
let kaiUrl = options.serverUrl;
let healthUrl = `${options.serverUrl}/api/extra/version`;
var lastRetrieved = null;
var lastStatus = null;
async function validateServer() {    
    if (lastStatus != null && (Date.now() - lastRetrieved) <= 30000) {
        return lastStatus;
    }
    lastRetrieved = Date.now();
    logger.debug("Retrieving settings from API Server...");

    try {
        const req = await axios.get(healthUrl);
        if (req.status === 200) {
            lastStatus = true;
        } else {
            logger.error(`Health check failed with status ${req.status}`);
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            logger.error(`Server ${kaiUrl} is up but does not appear to be a VLLM server.`);
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            logger.error(`Server ${kaiUrl} is not reachable. Are you sure it's running?`);
        } else {
            logger.error(error);
        }
        lastStatus = false;
    }
    return lastStatus;
}

const MAX_POP_RETRIES = 3;
const MAX_GENERATION_RETRIES = 3;

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
        models: [options.model],
        max_length: parseInt(options.ctx)/2,
        max_context_length: parseInt(options.ctx),
        priority_usernames: options.priorityUsernames,
        softprompts: [],
        bridge_agent: BRIDGE_AGENT
    };
    // logger.log(genDict);    

    // Pop a generation
    let loopRetry = 0;    
    while (loopRetry < MAX_POP_RETRIES) {
        let popReq = await safePost(`${cluster}/api/v2/generate/text/pop`, genDict);

        if (!popReq.ok) {
            await sleep(interval);
            loopRetry++;
            continue;
        }

        try {
            currentId = popReq.data.id;
            currentPayload = popReq.data.payload;
        } catch (error) {
            logger.error('textGenerationJob() PARSE ERROR', { 'error': error, 'data': popReq.data });
            await sleep(interval);
            loopRetry++;
            continue;
        }

        if (!currentId) {
            logger.debug(`Server ${cluster} has no valid generations to do for us. Skipped Info: ${popReq.data.skipped}.`);
            await sleep(interval);
            continue;
        }

        if (currentPayload.width || currentPayload.length || currentPayload.steps) {
            logger.error(`Stable Horde payload detected: ${currentPayload}. Aborting.`, currentPayload);
            currentId = null;
            currentPayload = null;
            continue;
        }

        if (!currentPayload.max_length) { currentPayload.max_length = 80; }
        if (!currentPayload.max_context_length) { currentPayload.max_context_length = 1024; }

        logger.info(`New job received from ${cluster} for ${currentPayload.max_length} tokens and ${currentPayload.max_context_length} max context.`);
        break;
    }

    // Handle pop failure
    if (!currentId) {
        return false;
    }

    // Select runtime
    const runtime = 'kobold';

    // Convert to VLLM parameters
    let generateUrl = `${options.serverUrl}/generate`;
    let vllm_request = {
        'prompt': currentPayload.prompt,
        'stop': currentPayload.stop_sequence ?? [],
        'max_tokens': currentPayload.max_length,
        'temperature': currentPayload.temperature ?? 1.0,
        'top_k': currentPayload.top_k ?? -1,
        'top_p': currentPayload.top_p ?? 1.0,
        'repetition_penalty': currentPayload.rep_pen ?? 1.0
    }
    // top_k cannot be 0
    if (vllm_request.top_k == 0) { vllm_request.top_k = -1; }
    // repetition_penalty must be in range (0,2]
    if (vllm_request.repetition_penalty > 2) { vllm_request.repetition_penalty = 2.0; }
    if (vllm_request.repetition_penalty < 0.01) { vllm_request.repetition_penalty = 0.01; }

    // sglang flavor of vLLM?
    if (runtime == 'sglang') {
        delete vllm_request.prompt
        vllm_request.max_new_tokens = vllm_request.max_tokens
        delete vllm_request.max_tokens
        // repetition_penalty not supported by sglang
        delete vllm_request.repetition_penalty

        vllm_request = {
            'text': currentPayload.prompt,
            'sampling_params': vllm_request
        }
    }
    
    if (runtime == 'kobold') {
        generateUrl = `${options.serverUrl}/api/v1/generate`;
        vllm_request = currentPayload;
    }

    // Generate with retry
    loopRetry = 0;
    while (loopRetry < MAX_GENERATION_RETRIES) {
        const req = await safePost(generateUrl, vllm_request);
        if (!req.ok) {
            logger.error('Generation problem, will try again...')
            await sleep(interval);
            loopRetry++;            
            continue;
        } else {
            logger.debug(`Generation ${currentId} completed with ${loopRetry} retries.`)
        }

        let generation;
        try {
            if (req.data.results) { req.data = req.data.results[0]; }
            generation = req.data.text;
            if (Array.isArray(generation)) { generation = generation[0]; }
        } catch (error) {
            logger.error('Generation PARSE ERROR', { 'error': error, 'data': popReq.data });
            await sleep(interval);
            loopRetry++;
            continue;
        }

        // Remove prompt from vllm responces
        if (runtime == 'vllm') {
            generation = generation.slice(vllm_request.prompt.length);
        }

        // Generate OK - submit it.
        submitGeneration({"id": currentId, "generation": generation});
        currentId = null;
        break;
    }

    // Handle generate failure
    if (currentId !== null) {
        logger.error(`Generation ${currentId} failed after ${loopRetry} retries.`)
        const fail_dict = {
            "id": currentId,
            "state": "faulted",
            "generation": "faulted",
            "seed": -1,
        }
        await safePost(`${cluster}/api/v2/generate/text/submit`, fail_dict);
        return false;
    }

    // Done.
    return true;
}

// logger.info(await validateServer());
// logger.info(await completionServer({'prompt': 'What is the capital of France?'}))

let running = true;
process.on('SIGINT', async function() {
    logger.error("Caught interrupt signal - shutting down");
    running = false;
});
process.on('uncaughtException', function(err) { 
    logger.error("Caught unexpected exception - shutting down", err);
    running = false;
}) 
process.on('uncaughtRejection', function(err) { 
    logger.error("Caught unexpected rejection - shutting down", err);
    running = false;
}) 

const MAX_FAILED_REQUESTS = 6;
async function runThread(t) { 
    let startTime = Date.now(); // Record the start time
    while (running) {
        let res;
        try {
            res = await textGenerationJob();
        } catch(error) {
            logger.error(`Thread ${t} FAILED`, error);
            res = null;
        }

        let endTime = Date.now(); // Record the end time
        let runtime = endTime - startTime;
        logger.info(`Thread ${t} iteration time ${runtime} ms result ${res}`);
        startTime = endTime; // Update the start time for the next iteration

        if (res !== true) {
            failedRequestsInARow++;
            if (failedRequestsInARow >= MAX_FAILED_REQUESTS) {
                logger.error('Failed too many requests in a row, aborting bridge...');
                running = false;
            }
        }
    }
    logger.info(`Thread ${t} shutting down.`)
}

const THREADS = parseInt(options.threads);
logger.info(`Spawning ${THREADS} worker threads.`)
let threads = []
for (let t=0; t<THREADS; t++) {
    threads.push(runThread(t));
}
logger.info('Press <Ctrl+C> to exit ...')
await Promise.all(threads);
logger.info('Worker threads have all exited.')

// await validateServer();