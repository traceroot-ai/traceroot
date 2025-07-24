# Welcome to TraceRoot!

Thank you for your interest in contributing to the TraceRoot project! 🎉 We're excited to have your support. As an open-source initiative in a rapidly evolving and open-ended field, we wholeheartedly welcome contributions of all kinds. Whether you want to introduce new features, enhance the infrastructure, improve documentation, asking issues, add more examples, implement state-of-the-art research ideas, or fix bugs, we appreciate your enthusiasm and efforts. 🙌  You are welcome to join our [discord](https://discord.gg/tPyffEZvvJ) for more efficient communication. 💬

## Join Our Community 🌍

### Schedule an Introduction Call 📞 

- [Schedule an Introduction Call](https://cal.com/traceroot/30min)

### Our Communication Channels 💬
- **Discord:** [Join here](https://discord.gg/tPyffEZvvJ)

## Contributing Guidelines 📝

### Reporting Issues 🐛

If you encounter any issues or have suggestions for improvements, please feel free to open an issue on our [GitHub repository](https://github.com/traceroot/traceroot/issues).

### Contributing Code 💻

If you're eager to contribute to this project, that's fantastic! We're thrilled to have your support.

Make sure to mention any related issues and tag the relevant maintainers too. 💪

Ensuring excellent documentation and thorough testing is absolutely crucial. Here are some guidelines to follow based on the type of contribution you're making:

- If you fix a bug:
  - Add a relevant unit test when possible. These can be found in the `test` directory.
- If you add a feature:
  - Include unit tests in the `test` directory.

We're a small team focused on building great things. If you have something in mind that you'd like to add or modify, opening a pull request is the ideal way to catch our attention. 🚀

#### Purpose of Code Reviews
- Maintain Code Quality: Ensure that the codebase remains clean, readable, and maintainable.
- Knowledge Sharing: Facilitate knowledge sharing among contributors and help new contributors learn best practices.
- Bug Prevention: Catch potential bugs and issues before they are merged into the main branch.
- Consistency: Ensure consistency in style, design patterns, and architecture across the project.

#### Review Process Overview
- Reviewers should check the code for functionality, readability, consistency, and compliance with the project’s coding standards.
- If changes are necessary, the reviewer should leave constructive feedback.
- The contributor addresses feedback and updates the PR.
- The reviewer re-reviews the updated code.
- Once the code is approved by at least two reviewer, it can be merged into the main branch.
- Merging should be done by a maintainer or an authorized contributor.

#### Code Review Checklist
- Functionality
  - Correctness: Does the code perform the intended task? Are edge cases handled?
  - Testing: Is there sufficient test coverage? Do all tests pass?
  - Security: Are there any security vulnerabilities introduced by the change?
  - Performance: Does the code introduce any performance regressions?

- Code Quality
  - Readability: Is the code easy to read and understand? Is it well-commented where necessary?
  - Maintainability: Is the code structured in a way that makes future changes easy?
  - Style: Does the code follow the project’s style guidelines?
  Currently we use Ruff for format check and take [Google Python Style Guide]("https://google.github.io/styleguide/pyguide.html") as reference.
  - Documentation: Are public methods, classes, and any complex logic well-documented?
- Design
  - Consistency: Does the code follow established design patterns and project architecture?
  - Modularity: Are the changes modular and self-contained? Does the code avoid unnecessary duplication?
  - Dependencies: Are dependencies minimized and used appropriately?

#### Reviewer Responsibilities
- Timely Reviews: Reviewers should strive to review PRs promptly to keep the project moving.
- Constructive Feedback: Provide feedback that is clear, constructive, and aimed at helping the contributor improve.
- Collaboration: Work with the contributor to address any issues and ensure the final code meets the project’s standards.
- Approvals: Only approve code that you are confident meets all the necessary criteria.

#### Common Pitfalls
- Large PRs: Avoid submitting PRs that are too large. Break down your changes into smaller, manageable PRs if possible.
- Ignoring Feedback: Address all feedback provided by reviewers, even if you don’t agree with it—discuss it instead of ignoring it.
- Rushed Reviews: Avoid rushing through reviews. Taking the time to thoroughly review code is critical to maintaining quality.

Code reviews are an essential part of maintaining the quality and integrity of our open source project. By following these guidelines, we can ensure that TraceRoot remains robust, secure, and easy to maintain, while also fostering a collaborative and welcoming community.

### Guideline for Writing Docstrings

This guideline will help you write clear, concise, and structured docstrings for contributing to `TraceRoot`.

#### 1. Use the Triple-Quoted String with `r"""` (Raw String)
Begin the docstring with `r"""` to indicate a raw docstring. This prevents any issues with special characters and ensures consistent formatting.

#### 2. Provide a Brief Class or Method Description
- Start with a concise summary of the purpose and functionality.
- Keep each line under `79` characters.
- The summary should start on the first line without a linebreak.

Example:
```python
r"""Class for TraceRoot.
"""
```

#### 3. Document Parameters in the Args Section
- Use an `Args`: section for documenting constructor or function parameters.
- Maintain the `79`-character limit for each line, and indent continuation lines by 4 spaces.
- Follow this structure:
  - Parameter Name: Match the function signature.
  - Type: Include the type (e.g., `int`, `str`, custom types like `BaseModelBackend`).
  - Description: Provide a brief explanation of the parameter's role.
  - Default Value: Use (`default: :obj:<default_value>`) to indicate default values.

Example:
```markdown
Args:
    system_message (BaseMessage): The system message for initializing 
        the agent's conversation context.
    model (BaseModelBackend, optional): The model backend to use for 
        response generation. Defaults to :obj:`OpenAIModel` with 
        `GPT_4O_MINI`. (default: :obj:`OpenAIModel` with `GPT_4O_MINI`)
```

### Principles 🛡️

#### Naming Principle: Avoid Abbreviations in Naming

- Abbreviations can lead to ambiguity, especially since variable names and code in TraceRoot are directly used by agents.
- Use clear, descriptive names that convey meaning without requiring additional explanation. This improves both human readability and the agent's ability to interpret the code.

Examples:

- Bad: msg_win_sz
- Good: message_window_size

By adhering to this principle, we ensure that TraceRoot remains accessible and unambiguous for both developers and AI agents.

#### Logging Principle: Use `logger` Instead of `print`

Avoid using `print` for output. Use Python's `logging` module (`logger`) to ensure consistent, configurable, and professional logging.

Examples:

- Bad: 
  ```python
  print("Process started")
  print(f"User input: {user_input}")
  ```
- Good: 
  ```python
  Args:
  logger.info("Process started")
  logger.debug(f"User input: {user_input}")
  ```

## Quick Start 🚀

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot

# Create and activate a virtual environment
python3.11 -m venv venv
source venv/bin/activate

# Install TraceRoot with all dependencies
pip install -e .

# The following command installs a pre-commit hook into the local git repo,
# so every commit gets auto-formatted and linted.
pre-commit install

# Run TraceRoot's pre-commit before push
pre-commit run --all-files

# Or
pre-commit run --files <file_name>

# Exit the virtual environment
deactivate
```
