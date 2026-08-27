import type { JsonValue } from "@mpx/core";

export type ProviderDataV1 = Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;

interface ProviderRecordV1 {
  readonly schemaVersion: 1;
  readonly providerData?: ProviderDataV1;
}

export interface IssueV1 extends ProviderRecordV1 {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "finished";
  readonly labels: readonly string[];
  readonly url?: string;
  readonly assignees?: readonly string[];
}

export interface IssueCommentV1 extends ProviderRecordV1 {
  readonly id: string;
  readonly issueId: string;
  readonly body: string;
  readonly author?: string;
  readonly createdAt?: string;
}

export interface ReviewV1 extends ProviderRecordV1 {
  readonly id: string;
  readonly title: string;
  readonly state: "draft" | "open" | "merged" | "closed";
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly url?: string;
}

export interface ReviewCommentV1 extends ProviderRecordV1 {
  readonly id: string;
  readonly reviewId: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
}

export interface CiLogV1 extends ProviderRecordV1 {
  readonly id: string;
  readonly content: string;
}

export interface CiRetryV1 extends ProviderRecordV1 {
  readonly id: string;
}

export interface CiCheckV1 {
  readonly id: string;
  readonly providerData?: ProviderDataV1;
  readonly name: string;
  readonly state: "pending" | "running" | "passed" | "failed" | "cancelled";
  readonly url?: string;
}

export interface CiStatusV1 extends ProviderRecordV1 {
  readonly state: "pending" | "running" | "passed" | "failed" | "cancelled";
  readonly checks: readonly CiCheckV1[];
}

export interface ProviderCapabilityInputMap {
  readonly "issue.list": Readonly<{ state?: "open" | "finished" }>;
  readonly "issue.view": Readonly<{ id: string }>;
  readonly "issue.create": Readonly<{ title: string; body: string }>;
  readonly "issue.edit": Readonly<{ id: string; title: string; body: string }>;
  readonly "issue.comment": Readonly<{ id: string; body: string }>;
  readonly "issue.label": Readonly<{ id: string; label: string }>;
  readonly "issue.move": Readonly<{ id: string; destination: string }>;
  readonly "issue.finish": Readonly<{ id: string }>;
  readonly "issue.dependency.add": Readonly<{ id: string; dependencyId: string; revision?: string }>;
  readonly "issue.dependency.remove": Readonly<{ id: string; dependencyId: string; revision?: string }>;
  readonly "review.view": Readonly<{ id: string }>;
  readonly "review.create": Readonly<{ title: string; body: string; sourceBranch: string; targetBranch: string; draft?: boolean }>;
  readonly "review.update": Readonly<{ id: string; title: string; body: string }>;
  readonly "review.comment": Readonly<{ id: string; body: string }>;
  readonly "review.ready": Readonly<{ id: string }>;
  readonly "review.merge": Readonly<{ id: string; method?: "merge" | "squash" | "rebase" }>;
  readonly "ci.status": Readonly<{ id: string }>;
  readonly "ci.watch": Readonly<{ id: string }>;
  readonly "ci.logs": Readonly<{ runId: string }>;
  readonly "ci.retry": Readonly<{ runId: string }>;
}

export interface ProviderCapabilityOutputMap {
  readonly "issue.list": readonly IssueV1[];
  readonly "issue.view": IssueV1;
  readonly "issue.create": IssueV1;
  readonly "issue.edit": IssueV1;
  readonly "issue.comment": IssueCommentV1;
  readonly "issue.label": IssueV1;
  readonly "issue.move": IssueV1;
  readonly "issue.finish": IssueV1;
  readonly "issue.dependency.add": IssueV1;
  readonly "issue.dependency.remove": IssueV1;
  readonly "review.view": ReviewV1;
  readonly "review.create": ReviewV1;
  readonly "review.update": ReviewV1;
  readonly "review.comment": ReviewCommentV1;
  readonly "review.ready": ReviewV1;
  readonly "review.merge": ReviewV1;
  readonly "ci.status": CiStatusV1;
  readonly "ci.watch": CiStatusV1;
  readonly "ci.logs": CiLogV1;
  readonly "ci.retry": CiRetryV1;
}
