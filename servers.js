import { defaultLogger, safePost } from './utils.js';

let servers = {};

servers.vllm = {
    'healthUrl': '/health',
    'generateUrl': '/generate',
    'generatePayload': (currentPayload) => {
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
        return vllm_request;
    },
    'extractGeneration': (data, prompt) => { 
        generation = data.text;
        if (Array.isArray(generation)) { generation = generation[0]; }
        return generation.slice(prompt.length);
    }
}

servers.tabbyapi = {
    'healthUrl': '/health',
    'generateUrl': '/v1/completions',
    'generatePayload': async (currentPayload, serverUrl) => {
        // disable TFS
        currentPayload.tfs = 1.0;
        // encode the prompt
        let prompt_tokens = await safePost(serverUrl+'/v1/token/encode', { 'text': currentPayload.prompt });
        if (!prompt_tokens.ok) {
            defaultLogger.error('ERROR: Something went wrong encoding tokens.')
            return currentPayload;
        }

        prompt_tokens = prompt_tokens.data;
        const max_context_length = (currentPayload.max_context_length || 2048);
        const max_response_length = (currentPayload.max_length || 256);
        const max_prompt_tokens = max_context_length - max_response_length;
        console.log('max_context_length=',max_context_length,' max_response_length=',max_response_length,' max_prompt_tokens=',max_prompt_tokens, ' prompt_tokens=', prompt_tokens.length)
        
        if (prompt_tokens.length > max_prompt_tokens) {
            // Keep the first half and last half of the tokens
            const halfMaxTokens = Math.floor(max_prompt_tokens / 2);
            const firstHalf = prompt_tokens.tokens.slice(0, halfMaxTokens);
            const secondHalf = prompt_tokens.tokens.slice(-halfMaxTokens);
            prompt_tokens.tokens = [...firstHalf, ...secondHalf];
            console.log('Trimmed',prompt_tokens.length,'to', prompt_tokens.tokens.length, 'tokens');

            let new_prompt = await safePost(serverUrl+'/v1/token/decode', { 'tokens': prompt_tokens.tokens });
            if (!new_prompt.ok) {
                defaultLogger.error('Failed to decode new prompt.')
            } else {
                currentPayload.prompt = new_prompt.data.text;
                //console.log(currentPayload.prompt);
            }
        }
        // debug
        // let debugPayload = {...currentPayload}
        // debugPayload.prompt = null;
        //console.log(JSON.stringify(currentPayload));
        return currentPayload;
    },
    'extractGeneration': (data, prompt) => { 
        return data.choices[0].text;
    }
}

servers.sglang = {
    'healthUrl': '/health',
    'generateUrl': '/generate',
    'generatePayload': (currentPayload) => {
        let sglang_request = {
            'text': currentPayload.prompt,
            'sampling_params': {
                'stop': currentPayload.stop_sequence ?? [],
                'max_new_tokens': currentPayload.max_length,
                'temperature': currentPayload.temperature ?? 1.0,
                'top_k': currentPayload.top_k ?? -1,
                'top_p': currentPayload.top_p ?? 1.0
            }
        }
        // top_k cannot be 0
        if (sglang_request.sampling_params.top_k == 0) { sglang_request.sampling_params.top_k = -1; }
        return sglang_request;
    },
    'extractGeneration': (data) => { 
        generation = data.text;
        if (Array.isArray(generation)) { generation = generation[0]; }
        return generation;
    }
}

servers.koboldcpp = {
    'healthUrl': '/api/extra/version',
    'generateUrl': '/api/v1/generate',
    'generatePayload': (currentPayload) => {
        return currentPayload;
    },
    'extractGeneration': (data) => { 
        return data.results[0].text;
    }
}

servers.llamacpp = {
    'healthUrl': '/props',
    'generateUrl': '/completion',
    'generatePayload': (currentPayload) => {
        let llamacpp_request = {
            'prompt': currentPayload.prompt,
            'stop': currentPayload.stop_sequence ?? [],
            // 'n_ctx': currentPayload.max_context_length,
            'n_predict': currentPayload.max_length,
            'n_keep': currentPayload.max_context_length-currentPayload.max_length,
            'temperature': currentPayload.temperature ?? 1.0,
            'tfs_z': currentPayload.tfs ?? 1.0,
            'top_k': currentPayload.top_k ?? -1,
            'top_p': currentPayload.top_p ?? 1.0,
            'repeat_penalty': currentPayload.rep_pen ?? 1.0,
            'repeat_last_n': currentPayload.rep_pen_range ?? 64,
            'typical_p': currentPayload.typical ?? 0.0,
        }
        return llamacpp_request;
    },
    'extractGeneration': (data) => { 
        return data.content;
    }
}

export default servers;
