import axios from 'axios';
import * as cheerio from 'cheerio';
import chalk from 'chalk';
import fs from 'fs';
import readline from 'readline';

let lastMessage = '';
let lastClipboardValue = '';
const totalClaims = {};
let isSleeping = false; // Flag to check if the script is sleeping
const taskQueue = []; // Array to hold tasks while sleeping

async function getConfig() {
    try {
        if (!fs.existsSync('config.json')) {
            throw new Error("Configuration file 'config.json' not found.");
        }
        
        const configData = fs.readFileSync('config.json', 'utf8');
        const config = JSON.parse(configData);

        if (!config.binance || !config.telegram || !config.telegram.channel_id) {
            throw new Error("Invalid configuration data in 'config.json'. Ensure that 'binance' and 'telegram.channel_id' are provided.");
        }

        return config;
    } catch (error) {
        console.error(chalk.red('Error reading configuration file:', error.message));
        process.exit(1);
    }
}

async function getLastMessageFromTelegramGroup(groupUrl) {
    try {
        const response = await axios.get(`https://t.me/s/${groupUrl}`);
        const html = response.data;
        const $ = cheerio.load(html);
        const newMessage = $('.tgme_widget_message_text').last().text().trim();
        return newMessage;
    } catch (error) {
        console.error('Error fetching data:', error.message);
        return null;
    }
}

function extractCodes(message) {
    const regex = /\b[A-Z0-9]{8}\b/g;
    return message.match(regex) || [];
}

function updateTotalClaims(token, amountStr) {
    const amount = parseFloat(amountStr);
    if (!totalClaims[token]) {
        totalClaims[token] = amount;
    } else {
        totalClaims[token] += amount;
    }
}

// Execute queued tasks
async function executeQueuedTasks() {
    while (taskQueue.length > 0) {
        const task = taskQueue.shift(); // Get the first task from the queue
        await task(); // Execute the task
    }
}

async function checkForNewMessages(groupUrl, binanceHeaders) {
    setInterval(async () => {
        const newMessage = await getLastMessageFromTelegramGroup(groupUrl);
        if (newMessage && newMessage !== lastMessage) {
            lastMessage = newMessage;
            const codes = extractCodes(newMessage);
            if (codes.length > 0) {
                console.log(chalk.gray(`\n-----------------------${new Date().toLocaleTimeString()}-----------------------`));
                console.log(chalk.blue('New Code Found:', codes));

                for (const code of codes) {
                    // Push tasks to the queue
                    taskQueue.push(async () => {
                        if (code !== lastClipboardValue) {
                            lastClipboardValue = code;
                            console.log(chalk.yellow(`Trying to claim code "${code}"...`));

                            const additionalHeaders = {
                                "accept": "*/*",
                                "accept-language": "en-US,en;q=0.6",
                                "bnc-location": "BINANCE",
                                "bnc-uuid": "30edea55-3710-4f28-b107-113db49a1d7b",
                                "content-type": "application/json",
                                "origin": "https://www.binance.com",
                                "referer": `https://www.binance.com/en/gift/query-and-receive?code=${code}`,
                                "sec-ch-ua-mobile": "?0",
                                "sec-fetch-dest": "empty",
                                "sec-fetch-mode": "cors",
                                "sec-fetch-site": "same-origin"
                            };

                            const updatedHeaders = { ...binanceHeaders, ...additionalHeaders };
                            const payload = { "grabCode": code };

                            try {
                                const response = await axios.post('https://www.binance.com/bapi/pay/v1/private/binance-pay/gift-box/code/grabV2', payload, { headers: updatedHeaders });

                                if (response.data && response.data.success === true) {
                                    console.log(chalk.green(`Claim Success [${response.data.data.grabAmountStr} ${response.data.data.currency}]`));
                                    
                                    const claimedToken = response.data.data.currency;
                                    updateTotalClaims(claimedToken, response.data.data.grabAmountStr);
                                    console.log(chalk.magenta(`Total ${claimedToken} Claim: ${totalClaims[claimedToken].toFixed(8)}`));
                                } else {
                                    console.log(chalk.red(`Claim Fail [${response.data.message}]`));
                                    
                                    const message = response.data.message;
                                    if (message.includes("You have exceeded the maximum attempts for your Red Packet code.")) {
                                        await handleSleep(message);
                                    }
                                }
                            } catch (error) {
                                handleError(error);
                            }
                            console.log(chalk.gray(`----------------------BY: @sakibweb---------------------`));
                        }
                    });
                }
                // Execute any queued tasks immediately
                await executeQueuedTasks();
            }
        }
    }, 1000);
}

async function handleSleep(message) {
    const timeMessage = message.split("Please try again in")[1]?.trim();

    if (timeMessage) {
        let [hoursPart, minutesPart] = timeMessage.split("hour(s)");
        let hours = 0, minutes = 0;

        if (hoursPart) {
            hours = parseInt(hoursPart.trim()) || 0; 
            if (minutesPart) {
                minutesPart = minutesPart.split("minute(s)")[0];
                minutes = parseInt(minutesPart.trim()) || 0;
            }
        }

        const totalSleepTime = (hours * 3600) + (minutes * 60);
        if (totalSleepTime > 0) {
            isSleeping = true; // Set the sleeping flag
            const totalSleepTimeInMillis = (totalSleepTime + 60) * 1000; 
            console.log(chalk.magenta(`Okay, I'm sleeping for ${hours} hour(s) and ${minutes} minute(s)...`));

            // Sleep for the calculated time
            await sleep(totalSleepTimeInMillis);

            isSleeping = false; // Reset the sleeping flag
            console.log(chalk.green("Umm, I'm awake right on time for my task."));
        } else {
            terminateScript("No valid time found.");
        }
    } else {
        terminateScript("No valid time portion found in the message.");
    }
}

function handleError(error) {
    if (error.response && error.response.status === 401) {
        terminateScript("Ops! Session is now expired. Please update credentials in config.json.");
    } else if (error.response && error.response.status === 403) {
        terminateScript("Forbidden access. Please check your permissions and credentials.");
    } else if (error.response && error.response.status === 500) {
        console.error(chalk.red("Server error. Please try again later."));
    } else {
        console.error(chalk.red('Unexpected error detected:'), error.message);
    }
}

function terminateScript(message) {
    console.log(chalk.red(message));
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Press R to restart or E to exit: ', (input) => {
        if (input.toLowerCase() === 'r') {
            console.log('Restarting the script...');
            rl.close();
            restartScript();
        } else if (input.toLowerCase() === 'e') {
            console.log('Exiting the script...');
            rl.close();
            process.exit(0);
        } else {
            console.log('Invalid input. Please press R to restart or E to exit.');
            rl.close();
            terminateScript(message);
        }
    });
}

function restartScript() {
    console.log('Script restarted.'); 
    main().catch(error => console.error(error));
}

// Sleep function that returns a Promise that resolves after a given time in milliseconds
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const config = await getConfig();
    await checkForNewMessages(config.telegram.channel_id, config.binance);
}

main().catch(error => console.error(error));
