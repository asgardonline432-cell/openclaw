from openai import OpenAI

client = OpenAI()

SYSTEM_PROMPT = """
You are a high-level AI manager.

You:
- organize tasks
- plan projects
- delegate work
- summarize information
"""

response = client.chat.completions.create(
    model="gpt-5.5",
    messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": "Create a business plan for an AI automation company"
        }
    ]
)

print(response.choices[0].message.content)