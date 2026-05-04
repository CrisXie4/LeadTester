# LeadTester

API pressure-test configuration panel for AI RPM, HTTP QPS, and simple HTTP test scenarios.

Made By [CrisXie](https://github.com/CrisXie4/LeadTester)

## Vercel Static Sharing

This project includes `vercel.json`, so Vercel can serve `src/web/ui.html` directly.

The Vercel version does not need a backend. It is designed for sharing test configurations:

1. Fill in the test parameters on the page.
2. Click `Share Test Link`.
3. Send the copied URL to someone else.
4. The receiver opens the URL and gets the same configuration restored.

API keys are never included in shared URLs. Each user should enter their own key locally.

## Local Dashboard

Run the Node dashboard when you need real test execution, live monitoring, and report generation:

```bash
npm install
npm run dashboard
```

## CLI

```bash
npm run ai
npm run http
npm start
```

## Notes

The Vercel static page cannot run server-side pressure tests or persist reports. It only edits and shares configurations. Use the local dashboard or CLI for actual test execution.
