// global field config
// this is where we setup all the fields for the database and validation
const submissionRegistry = [
	{
		dbKey: 'name', // this is the name of the column in our database
		presenceRequired: true, // means the user MUST type something here
		maxCharacterLimit: 3, // only allow 3 letters so they dont break stuff
		alphabeticOnlyPattern: /^[a-zA-Z]+$/, // only allow real letters, no numbers or weird symbols
	},
	{
		dbKey: 'content', // another column for the actual message
		presenceRequired: true, // also mandatory
		maxCharacterLimit: 3, // keep it short too
		alphabeticOnlyPattern: /^[a-zA-Z]+$/, // letters only again
	},
];

// internal utility functions
// just some helper stuff for the main code to use

// verifySecurityToken: checking if the user is a real human or a bot
const verifySecurityToken = async (userToken, environmentBindings) => {
	const secretKey = environmentBindings.TURNSTILE_SECRET_KEY; // get our secret key from the settings
	const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'; // this is where we ask cloudflare if its a bot

	// check if we even have a key
	if (!secretKey) {
		console.error('ERROR: TURNSTILE_SECRET_KEY is undefined in environment.'); // log a big error if its missing
		return { success: false, 'error-codes': ['missing-configuration'] }; // tell the caller it failed cuz of config
	}

	// prep the data to send to cloudflare
	const verificationPayload = new URLSearchParams({
		secret: secretKey, // our secret key
		response: userToken, // the token the user sent us
	});

	// send the request to cloudflare
	const apiResponse = await fetch(verifyUrl, {
		body: verificationPayload, // put the data in the body
		method: 'POST', // use post cuz we are sending data
	});

	// get the answer back as json
	const verificationResult = await apiResponse.json(); // wait for the json to parse
	if (!verificationResult.success) {
		console.error('VERIFICATION_FAILURE:', verificationResult['error-codes']); // log if cloudflare says no
	}

	return verificationResult; // return the whole result object
};

// persistDataRecord: saves a new entry into our d1 database
const persistDataRecord = async (dataObject, environmentBindings) => {
	// lets get the column names first
	const columnNames = submissionRegistry.map((field) => {
		return field.dbKey; // this gets the db key for each field in our list
	});

	// now we need some question marks for the sql query
	const placeholderArray = columnNames.map(() => {
		return '?'; // just a placeholder so nobody can hack our sql
	});
	const valuePlaceholders = placeholderArray.join(', '); // join em with commas like "?, ?, ?"

	// building the actual sql string here
	const columnsString = columnNames.join(', '); // join column names with commas too
	const insertSql = `INSERT INTO entries (${columnsString}) VALUES (${valuePlaceholders});`; // the big insert query string

	// mapping the data to the right order so it matches the columns
	const orderedValues = columnNames.map((key) => {
		return dataObject[key]; // gets the actual value from the user data
	});

	// finally running the db command
	const preparedStatement = environmentBindings.D1.prepare(insertSql); // tell the db to get ready
	const boundStatement = preparedStatement.bind(...orderedValues); // put the real values in the placeholders
	const executionResult = await boundStatement.run(); // run it and wait for it to finish saving

	return executionResult; // send back the result so we know it worked
};

// retrieveAllRecords: gets everything out of the database
const retrieveAllRecords = async (environmentBindings) => {
	// getting the keys we need to select
	const columnKeysArray = submissionRegistry.map((field) => {
		return field.dbKey; // grab the db key for each column
	});

	// join them up for the select statement
	const selectKeys = columnKeysArray.join(', '); // make a comma separated list of columns

	// build the select query
	const selectSql = `SELECT ${selectKeys} FROM entries;`; // get all columns from the entries table

	// talk to the database
	const preparedStatement = environmentBindings.D1.prepare(selectSql); // prep the select query
	const queryResult = await preparedStatement.all(); // get all the rows at once

	// check if it actually worked or if the db crashed
	if (!queryResult.success) {
		throw new Error('Database archival retrieval failed.'); // oops something went wrong big time
	}

	// make sure we return an array even if its empty
	let results; // variable to hold our list of data
	if (queryResult.results) {
		results = queryResult.results; // if we got data, use it
	} else {
		results = []; // if no data, just make it an empty list so it dont crash
	}
	return results; // return the list of rows
};

// handlePostRequest: handles when someone submits the form
const handlePostRequest = async (incomingRequest, environmentBindings, standardJsonResponseHeaders) => {
	try {
		const requestPayload = await incomingRequest.json(); // parse the json data from the request
		const { turnstileToken } = requestPayload; // grab the token for security checks

		// do the security check to stop bots
		const securityError = await validateSecurity(turnstileToken, environmentBindings); // check if its a bot or not
		if (securityError) {
			return new Response(JSON.stringify({ error: securityError }), {
				status: 400, // bad request if security fails
				headers: standardJsonResponseHeaders, // send back our standard headers
			});
		}

		// check all the fields to make sure they are valid
		const validationError = validateFields(requestPayload); // check if the data is gud and follows rules
		if (validationError) {
			return new Response(JSON.stringify({ error: validationError }), {
				status: 400, // bad request if validation fails
				headers: standardJsonResponseHeaders, // send back headers again
			});
		}

		// save to the database now that its clean
		const sanitizedEntry = {}; // new object for clean data only
		submissionRegistry.forEach((field) => {
			sanitizedEntry[field.dbKey] = requestPayload[field.dbKey]; // copy only the fields we allow
		});

		await persistDataRecord(sanitizedEntry, environmentBindings); // save it to the d1 database for real

		return new Response(JSON.stringify({ success: true }), {
			status: 200, // all good!
			headers: standardJsonResponseHeaders, // send back success msg
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: 'Ingestion failed', message: error.message }), {
			status: 500, // server error if somthing broke in the code
			headers: standardJsonResponseHeaders, // send back error msg
		});
	}
};

// validateSecurity: helper to check turnstile
const validateSecurity = async (turnstileToken, environmentBindings) => {
	// check if turnstile is even turned on in the settings
	if (environmentBindings.USETURNSTILE === '0') {
		return null; // its off so just skip the check
	}

	// make sure the user actually sent a token
	if (!turnstileToken) {
		return 'Security token required.'; // gotta have a token or we dont trust u
	}

	// verify the token with cloudflare's api
	const securityOutcome = await verifySecurityToken(turnstileToken, environmentBindings); // wait for cf to reply
	if (!securityOutcome.success) {
		return 'Bot verification failed.'; // cf thinks its a bot so we block it
	}

	return null; // no errors found, user is cool
};

// validateFields: checks every field against our config rules
const validateFields = (requestPayload) => {
	// loop through each field in our config list
	for (const fieldDefinition of submissionRegistry) {
		const userInput = requestPayload[fieldDefinition.dbKey]; // get what the user typed for this field
		const fieldId = fieldDefinition.dbKey; // the name/id of the field

		// check if its missing but required
		if (fieldDefinition.presenceRequired && !userInput) {
			return `Missing required field: ${fieldId}`; // error if its empty when it shouldnt be
		}

		// check if its too long (too many characters)
		if (userInput && userInput.length > fieldDefinition.maxCharacterLimit) {
			return `Length exceeded for field: ${fieldId}`; // error if they typed too much
		}

		// check if it has weird characters that arent letters
		if (userInput && fieldDefinition.alphabeticOnlyPattern && !fieldDefinition.alphabeticOnlyPattern.test(userInput)) {
			return `Invalid characters in field: ${fieldId}`; // error if not just abc letters
		}
	}
	return null; // everything looks fine to me
};

export default {
	// this is the main part of the worker that handles requests
	async fetch(incomingRequest, environmentBindings, context) {
		// setup some headers for cross-origin stuff (cors)
		const accessControlHeaders = {
			'Access-Control-Allow-Origin': 'https://anthonyis.online', // only allow my website to call this
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // allow these types of requests
			'Access-Control-Allow-Headers': 'Content-Type', // allow the content-type header
		};

		// standard headers for our json responses
		const standardJsonResponseHeaders = {
			'Content-Type': 'application/json', // tell the browser we are sending json
			...accessControlHeaders, // add the cors headers too
		};

		// handle options requests for cors preflight
		if (incomingRequest.method === 'OPTIONS') {
			return new Response(null, { 
				status: 204, // 204 means "no content" which is fine for options
				headers: accessControlHeaders // send back the cors headers
			});
		}

		// handle get requests to show all the data
		if (incomingRequest.method === 'GET') {
			try {
				// try to get everything from the database
				const databaseSnapshot = await retrieveAllRecords(environmentBindings); // wait for the db to give us rows
				return new Response(JSON.stringify(databaseSnapshot), {
					status: 200, // 200 means success
					headers: standardJsonResponseHeaders, // send back the data as json
				});
			} catch (error) {
				// if something breaks during the get request
				return new Response(JSON.stringify({ error: 'Retrieval failed', message: error.message }), {
					status: 500, // 500 is a generic server error
					headers: standardJsonResponseHeaders, // send back the error info
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
