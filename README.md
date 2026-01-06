# Submission worker demo 

This repo is for a cloudflare worker that handles form submissions and saves them into a d1 database. Also checks if the user is a real person using [cloudflare turnstile](https://developers.cloudflare.com/turnstile/).

### How it works
#### POST 
1. When someone sends data, we check the turnstile token. 
2. The worker has been stripped becuase it's facing the public. So, we check the name and message to make sure they are max 3 characters and have A..Z or a..z. 
3. If everything is good, we save it into our d1 database. We use placeholders to prevent sql injection.
#### GET
Grab everything from the database and shows it to you as a list.

### Env
- **TURNSTILE_SECRET_KEY:** secret key, store as a secret in env. 
- **USETURNSTILE:** for debug, set to 1 to enable, 0 to not. 
- **D1:** the database binding where all the messages live.

# Learning 

## Reserved word issues
- `const columnsString = columnNames.map(name => `"${name}"`).join(', ');` is done such that if a reserved word is passed in, it does not create an error. 

## .join 
```javascript
const valuePlaceholders = new Array(columnNames.length).fill('?').join(', '); 
        // e.g new Array(2).fill('?') -> ['?', '?'] -> "?, ?"
		// new Array(2) creates a double, then we .fill with ?, then we .join with commas which then makes a string instead of a double
```

## HTTP status codes
New codes I found and used:

https://en.wikipedia.org/wiki/List_of_HTTP_status_codes

- 204: no content
- 405: method not allowed 

## Ensuring POST: 
1. Does not contain extra fields: 
```javascript
		const sanitizedEntry = {}; // init new object 
		submissionRegistry.forEach((field) => { // iterate each key in the registry
			if (requestPayload[field.key] !== undefined && requestPayload[field.key] !== null) { // if data neq undefined and null,
				sanitizedEntry[field.key] = requestPayload[field.key]; // set it 
			} else {
				sanitizedEntry[field.key] = null; // otherwise set null, if data missing 
			}
		}); 
```
In the above, we create a new object, then iterate each field.key (so each key) in the submission registry. In this case, we only have the `name` and `content` keys. We then verify the request payload is valid. 
For thsi: `requestPayload[field.key]`, the following example demonstrates this best: 
    
If we have a payload: 
```javascript
    const requestPayload = {
        name: "Ant",
        content: "hi",
        extraData: "remove me"
    };
```
The registry is defined as:
```javascript
    const field = {
        key: 'name',
        presenceRequired: true,
        maxCharacterLimit: 3,
        regex: /^[a-zA-Z]+$/,
    };
```
1. When running `requestPayload[field.key]`, we look at `field.key` and see `name`. 
2. Then, it turns into `requestPayload['name']`. 
3. Then, it resolves into `"Ant"`, being the value in the kv pair.