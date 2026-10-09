# Quality Enhancer Studio — Mobile Deployment Bundle

## Fastest path to a public mobile-friendly URL

1. Download and extract this ZIP.
2. Upload the extracted files to a **private GitHub repository**. Do not upload `.env` files or API keys.
3. Open https://dashboard.render.com/ and sign in.
4. Choose **New → Blueprint**, connect your repository, and select `render.yaml`.
5. Enter the secret values when prompted:
   - `APP_PASSWORD`: a strong password you choose for your personal website.
   - `TOPAZ_API_KEY`: your own Topaz Labs API key.
6. Deploy. Render will provide a public `https://...onrender.com` URL.
7. Open that URL in Chrome on your phone. The browser will ask for your site password.

Official guides:
- Render web services: https://render.com/docs/web-services
- Render environment secrets: https://render.com/docs/configure-environment-variables
- Render Blueprints: https://render.com/docs/blueprint-spec

## Important limitations

- This ZIP is source code, **not a live website**. Hosting login/repository access and your own secret values are needed to publish a URL. I cannot sign in to your Render/GitHub account or deploy on your behalf from this chat.
- Image and video API integration has not been tested with a live Topaz account. Verify current endpoint parameters, model names, and response schemas in Topaz's official documentation before relying on it.
- The server uses an in-memory upload and has a 100 MB limit. Progress is an estimate, not an exact provider progress value.
- Topaz API use may consume credits. Keep the API key private and keep the password gate enabled.
- Free hosting may sleep after inactivity, so the first visit may take a little longer.

## Run locally

Requires Node.js 20+:

```bash
npm install
cp .env.example .env
npm start
```

Set your own `APP_PASSWORD` and `TOPAZ_API_KEY` in `.env` first. Open `http://localhost:3000`.

Topaz official docs:
- https://developer.topazlabs.com/getting-started/quickstart
- https://developer.topazlabs.com/getting-started/video-quickstart
- https://developer.topazlabs.com/
