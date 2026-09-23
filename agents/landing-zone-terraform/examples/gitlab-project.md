# New component repositories start in the GitLab control plane

Tags: GitLab project, dhco-gitlab-terraform, component onboarding

User: Create a dedicated GitLab project for a new Landing Zone component.

Expected behaviour:

Route to `dhco-gitlab-terraform`. Check for an existing project and ownership conflict before proposing the project, protections, approvals, and seeded files. The verified project path and project ID are downstream inputs to runner registration.

Do not create a project for ordinary application-account onboarding and do not guess a namespace or project ID.
