import axios from 'axios';

/**
 * Makes a POST request with error handling
 * @param {string} url - The URL to post to
 * @param {object} body - The request body
 * @param {object} headers - Request headers
 * @param {number} timeout - Request timeout in milliseconds
 * @param {object} logger - Winston logger instance
 * @returns {object} Response with ok flag
 */
export async function safePost(url, body, headers, timeout, logger) {
    let resp;

    try {
        resp = await axios.post(url, body, { headers, timeout });
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
