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