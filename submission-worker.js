const submissionRegistry = [
	{
		key: 'name', // this is the 'name' column in db
		presenceRequired: true,
		maxCharacterLimit: 3,
		regex: /^[a-zA-Z]+$/,
	},
	{
		key: 'content', 
		presenceRequired: true,
		maxCharacterLimit: 3, 
		regex: /^[a-zA-Z]+$/,
	},
];

// helpers
const verifySecurityToken = async (userTurnstileToken, environmentBindings) => {
	const secretKey = environmentBindings.TURNSTILE_SECRET_KEY;
	const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'; // this is where we ask cloudflare if its a bot

	if (!secretKey) { // ensure key 
		console.error('ERROR: TURNSTILE_SECRET_KEY is undefined in environment.'); 
		return { success: false, 'error-codes': ['missing-configuration'] }; 
	}

	const turnstileVerificationPayload = new URLSearchParams({
		secret: secretKey,
		response: userTurnstileToken, 
	});

	const apiResponse = await fetch(verifyUrl, { // send request, await 
		body: turnstileVerificationPayload, 
		method: 'POST', 
	});

	const verificationResult = await apiResponse.json(); // wait for the json to parse
	if (!verificationResult.success) {
		console.error('VERIFICATION_FAILURE:', verificationResult['error-codes']); 
	}

	return verificationResult; // return result obj
};

const persistDataRecord = async (dataObject, environmentBindings, tableName) => { // save new entry 
	const columnNames = submissionRegistry.map((field) => {
		return field.key; // this gets the db key for each field in our list
	});

	const columnsString = columnNames.map(name => `"${name}"`).join(', '); // join each element with commas to avoid reserved word issues

	const valuePlaceholders = new Array(columnNames.length).fill('?').join(', '); // e.g new Array(2).fill('?') -> ['?', '?'] -> "?, ?"
		// new Array(2) creates a double, then we .fill with ?, then we .join with commas which then makes a string instead of a double
		// .join only puts commas between items, so better than doing a for loop. Also looks nicer too 

	const insertSql = `INSERT INTO ${tableName} (${columnsString}) VALUES (${valuePlaceholders});`; 
		// the valueplaceholders makes the insert string look like: `INSERT INTO "entries" ("name", "content") VALUES (?, ?);`, which is nice.

	const orderedValues = columnNames.map((key) => {
		// if key name, look at dataObject['name'] and finds "name"
		// if key content, look at dataObject['content'] and finds "content"
		return dataObject[key]; // return ["name", "content"]
	});

	// finally running the db command
	const preparedStatement = environmentBindings.D1.prepare(insertSql); // tell the db to get ready
	const boundStatement = preparedStatement.bind(...orderedValues); // put the real values in the placeholders
	const executionResult = await boundStatement.run(); // run it and wait for it to finish saving

	return executionResult; // send back the result so we know it worked
};

// retrieveAllRecords: gets everything out of the database
const retrieveAllRecords = async (environmentBindings, tableName) => {
	
	// pull the key field(s) from the submissionRegistry
	const columnKeysArray = submissionRegistry.map((field) => {
		return field.key; // returns ['name', 'content'] in this case
	});

	// join them up for the select statement
	const selectKeys = columnKeysArray.join(', '); // make a comma separated list of columns, like "name, content"

	// build the select query
	const selectSqlcmd = `SELECT ${selectKeys} FROM ${tableName};`; // ask db for all rows, but only specific keys 

	const preparedStatement = environmentBindings.D1.prepare(selectSqlcmd); // send cmd to db
	const queryResult = await preparedStatement.all(); // await tells to execute the command and save the result 

	if (!queryResult.success) {
		throw new Error('Database retrieval failed.');
	}

	let results; // variable to hold our list of data
	if (queryResult.results) {
		results = queryResult.results; 
	} else {
		results = []; // return empty list if no data 
	}
	return results; // return the list of rows
};

const handlePostRequest = async (incomingRequest, environmentBindings, standardJsonResponseHeaders) => {
	try {
		const requestPayload = await incomingRequest.json(); // parse the json data from the request
		//e.g. 
		// {
		// 	"name": "Ant",
		// 	"content": "hi",
		// 	"turnstileToken": "tokenstirng00000"
		// }
		const turnstileToken = requestPayload.turnstileToken; // get the turnstileToken member from the JSON 

		const validateSecurityResult = await validateSecurity(turnstileToken, environmentBindings);
		if (validateSecurityResult) { // not null, bad token maybe 
			return new Response(JSON.stringify({ error: validateSecurityResult }), {
				status: 400,
				headers: standardJsonResponseHeaders,
			});
		}

		const validationError = validateFields(requestPayload); // check if the data is gud and follows rules
		if (validationError) {
			return new Response(JSON.stringify({ error: validationError }), {
				status: 400,
				headers: standardJsonResponseHeaders,
			});
		}

		const sanitizedEntry = {}; // init new object 
		submissionRegistry.forEach((field) => { // iterate each key in the registry
			if (requestPayload[field.key] !== undefined && requestPayload[field.key] !== null) { // if data neq undefined and null,
				sanitizedEntry[field.key] = requestPayload[field.key]; // set it 
			} else {
				sanitizedEntry[field.key] = null; // otherwise set null, if data missing 
			}
		}); // we iterate each key in the registry, then look for a matching key in the payload. Key is the same, then we set the data. 
			//e.g
				// Input (requestPayload): {"name": "Ant", "hacker_tool": "virus"}
				// submissionRegistry: ['name', 'content']
				// Output (sanitizedEntry): {"name": "Ant", "content": null}

		await persistDataRecord(sanitizedEntry, environmentBindings, 'entries'); // save into d1

		return new Response(JSON.stringify({ success: true }), {
			status: 200, // OK 
			headers: standardJsonResponseHeaders,
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: 'Ingestion failed', message: error.message }), {
			status: 500,
			headers: standardJsonResponseHeaders,
		});
	}
};

const validateSecurity = async (turnstileToken, environmentBindings) => {
	if (environmentBindings.USETURNSTILE === '0') {
		return null;
	}

	if (!turnstileToken) {
		return 'Security token required.';
	}

	const securityOutcome = await verifySecurityToken(turnstileToken, environmentBindings); // wait for cf to reply
	if (!securityOutcome.success) {
		return 'Bot verification failed.';
	}

	return null; 
};

const validateFields = (requestPayload) => {
	for (const field of submissionRegistry) { // loop through each field in our config list
		const userInput = requestPayload[field.key]; 
		const fieldId = field.key;

		if (field.presenceRequired && !userInput) {
			return `Missing required field: ${fieldId}`;
		}

		if (userInput && userInput.length > field.maxCharacterLimit) {
			return `Length exceeded for field: ${fieldId}`;
		}

		if (userInput && field.regex && !field.regex.test(userInput)) {
			return `Invalid characters in field: ${fieldId}`; // error if not just a..z letters
		}
	}
	return null;
};

export default {
	// this is the main part of the worker that handles requests
	async fetch(incomingRequest, environmentBindings, context) {
		const accessControlHeaders = {
			'Access-Control-Allow-Origin': 'https://anthonyis.online', // only allow my website to call this
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // allow these types of requests
			'Access-Control-Allow-Headers': 'Content-Type', // allow the content-type header
		};

		const standardJsonResponseHeaders = {
			'Content-Type': 'application/json',
			...accessControlHeaders, // like a header file, pull accessControlHeaders and paste it here 
		};

		if (incomingRequest.method === 'OPTIONS') {
			return new Response(null, { 
				status: 204, // 204 means "no content" https://en.wikipedia.org/wiki/List_of_HTTP_status_codes
				headers: accessControlHeaders
			});
		}

		if (incomingRequest.method === 'GET') {
			try {
				const databaseSnapshot = await retrieveAllRecords(environmentBindings, 'entries'); // wait for the db to give us rows
				return new Response(JSON.stringify(databaseSnapshot), {
					status: 200, 
					headers: standardJsonResponseHeaders, // send back the data as json
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: 'Retrieval failed', message: error.message }), {
					status: 500,
					headers: standardJsonResponseHeaders,
				});
			}
		}

		// handle post requests when someone sends data
		if (incomingRequest.method === 'POST') {
			// run the post handler logic
			const postResponse = await handlePostRequest(incomingRequest, environmentBindings, standardJsonResponseHeaders); // wait for it
			return postResponse; // send the response back to the user
		}

		// if they try any other method like put or delete
		return new Response(JSON.stringify({ error: 'Method disallowed.' }), {
			status: 405, // 405 means "method not allowed"
			headers: standardJsonResponseHeaders, // send back the rejection
		});
	},
};
