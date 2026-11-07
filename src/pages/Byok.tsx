import {
	ArrowPathIcon,
	ArrowUpTrayIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	ClipboardDocumentIcon,
	EyeIcon,
	EyeSlashIcon,
	PencilSquareIcon,
	PlusIcon,
	XMarkIcon,
} from "@heroicons/react/20/solid";
import {
	CommandLineIcon,
	InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type React from "react";
import {
	Fragment,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth";
import { HealthBadge, type HealthStatus } from "../components/HealthBadge";
import { Modal } from "../components/Modal";
import { ProviderChip } from "../components/ProviderLogo";
import { ProviderSelect } from "../components/ProviderSelect";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { Button, Input, PromoBanner } from "../components/ui";
import { useFetch } from "../hooks/useFetch";
import { useFormatDateTime } from "../hooks/useFormatDateTime";
import type { CredentialGuide, ProviderMeta } from "../types/provider";
import { TOKENS } from "../utils/colors";
import { formatUSD } from "../utils/format";
import { toastApiError } from "../utils/toast-error";

interface CredentialInfo {
	id: string;
	provider_id: string;
	authType: "api_key" | "oauth";
	secretHint: string;
	quota: number | null;
	quotaSource: "auto" | "manual" | null;
	health: HealthStatus;
	isEnabled: boolean;
	priceMultiplier: number;
	addedAt: number;
	earnings: number;
}

export function Byok() {
	const { t } = useTranslation();
	const { getToken } = useAuth();
	const formatDateTime = useFormatDateTime();

	const { data, loading, refetch } =
		useFetch<CredentialInfo[]>("/api/credentials");
	const credentials = data || [];

	const { data: providersData } = useFetch<ProviderMeta[]>(
		"/api/providers?all=1",
		{ requireAuth: false },
	);
	const providers = providersData || [];

	const [isAddOpen, setIsAddOpen] = useState(false);
	const [isBulkImport, setIsBulkImport] = useState(false);
	const [bulkSecrets, setBulkSecrets] = useState("");
	const [isImporting, setIsImporting] = useState(false);
	const [importProgress, setImportProgress] = useState({ done: 0, total: 0 });
	const [showPassword, setShowPassword] = useState(false);
	const defaultProvider = providers[0]?.id ?? "openrouter";
	const [draft, setDraft] = useState({
		provider_id: defaultProvider,
		secret: "",
		quota: "",
		isEnabled: true,
		priceMultiplier: "1.0",
	});
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editQuota, setEditQuota] = useState("");
	const [editingSettingsId, setEditingSettingsId] = useState<string | null>(
		null,
	);
	const [editPriceMultiplier, setEditPriceMultiplier] = useState("");
	const [refreshingQuotaId, setRefreshingQuotaId] = useState<string | null>(
		null,
	);
	const [selectedCredentialIds, setSelectedCredentialIds] = useState(
		() => new Set<string>(),
	);
	const [isDeletingSelected, setIsDeletingSelected] = useState(false);
	const [isCheckingHealth, setIsCheckingHealth] = useState(false);
	const [expandedProviders, setExpandedProviders] = useState(
		() => new Set<string>(),
	);
	const selectAllRef = useRef<HTMLInputElement>(null);
	const credentialGroups = useMemo(() => {
		const groups = new Map<string, CredentialInfo[]>();
		for (const credential of credentials) {
			const group = groups.get(credential.provider_id) ?? [];
			group.push(credential);
			groups.set(credential.provider_id, group);
		}
		return [...groups.entries()];
	}, [credentials]);
	const selectedCredentials = credentials.filter((credential) =>
		selectedCredentialIds.has(credential.id),
	);
	const allCredentialsSelected =
		credentials.length > 0 && selectedCredentials.length === credentials.length;
	const partiallySelected =
		selectedCredentials.length > 0 && !allCredentialsSelected;

	useEffect(() => {
		if (selectAllRef.current) {
			selectAllRef.current.indeterminate = partiallySelected;
		}
	}, [partiallySelected]);

	const getHeaders = async () => ({
		"Content-Type": "application/json",
		Authorization: `Bearer ${await getToken()}`,
	});

	const selectedProvider = providers.find((p) => p.id === draft.provider_id);
	const isAutoProvider = selectedProvider?.supportsAutoCredits ?? false;
	const isSubProvider = selectedProvider?.isSubscription ?? false;
	const needsManualQuota = !isAutoProvider && !isSubProvider;
	const isOAuth = selectedProvider?.authType === "oauth";
	const guide = selectedProvider?.credentialGuide;
	const [guideOpen, setGuideOpen] = useState(true);
	const [priceMultiplierTouched, setPriceMultiplierTouched] = useState(false);

	const secretHint = useMemo<{
		type: "json" | "access_token" | null;
		message: string;
	}>(() => {
		const v = draft.secret.trim();
		if (!v) return { type: null, message: "" };
		if (v.startsWith("{"))
			return { type: "json", message: t("credentials.hint_json_detected") };
		if (v.startsWith("ya29.") || v.startsWith("aoa"))
			return {
				type: "access_token",
				message: t("credentials.hint_access_token"),
			};
		return { type: null, message: "" };
	}, [draft.secret, t]);

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault();

		if (needsManualQuota && !draft.quota) {
			toast.error(t("credentials.error_quota_required"));
			return;
		}

		if (isBulkImport) {
			await handleBulkImport();
			return;
		}

		const trimmedSecret = draft.secret.trim();
		if (guide?.secretPattern && !isOAuth) {
			const re = new RegExp(guide.secretPattern);
			if (!re.test(trimmedSecret)) {
				toast.error(
					t("credentials.error_secret_format", {
						example: guide.placeholder,
					}),
				);
				return;
			}
		}

		const tid = toast.loading(t("common.loading"));
		try {
			const body: Record<string, unknown> = {
				provider_id: draft.provider_id,
				secret: draft.secret,
				isEnabled: draft.isEnabled ? 1 : 0,
				priceMultiplier: Number.parseFloat(draft.priceMultiplier) || 1.0,
			};

			if (needsManualQuota && draft.quota) {
				body.quota = Number.parseFloat(draft.quota) || 0;
			}

			const res = await fetch("/api/credentials", {
				method: "POST",
				headers: await getHeaders(),
				body: JSON.stringify(body),
			});
			const data = await res.json();
			if (res.ok) {
				setIsAddOpen(false);
				setDraft({
					provider_id: defaultProvider,
					secret: "",
					quota: "",
					isEnabled: true,
					priceMultiplier: providers.find((p) => p.id === defaultProvider)
						?.isSubscription
						? "0.1"
						: "0.5",
				});
				setShowPassword(false);
				setPriceMultiplierTouched(false);
				refetch();
				toast.success(t("common.success"), { id: tid });
			} else {
				toastApiError(data, t, tid);
			}
		} catch (err) {
			console.error(err);
			toast.error(t("common.error"), { id: tid });
		}
	};

	const handleBulkImport = async () => {
		const entries = bulkSecrets
			.split(/\r?\n/)
			.map((secret, index) => ({ secret: secret.trim(), line: index + 1 }))
			.filter((entry) => entry.secret.length > 0);

		if (entries.length === 0) {
			toast.error(t("credentials.bulk_empty"));
			return;
		}
		if (entries.length > 500) {
			toast.error(t("credentials.bulk_limit"));
			return;
		}

		const seenSecrets = new Set<string>();
		const uniqueEntries: typeof entries = [];
		let duplicateCount = 0;
		for (const entry of entries) {
			if (seenSecrets.has(entry.secret)) {
				duplicateCount += 1;
				continue;
			}
			seenSecrets.add(entry.secret);
			uniqueEntries.push(entry);
		}
		const inputDuplicateCount = duplicateCount;

		setIsImporting(true);
		setImportProgress({ done: inputDuplicateCount, total: entries.length });
		const tid = toast.loading(t("common.loading"));
		const failures: typeof entries = [];
		const failureCounts = new Map<string, number>();
		let imported = 0;
		const secretPattern =
			guide?.secretPattern && !isOAuth ? new RegExp(guide.secretPattern) : null;

		try {
			const headers = await getHeaders();
			const quota = needsManualQuota
				? Number.parseFloat(draft.quota)
				: undefined;
			const priceMultiplier = Number.parseFloat(draft.priceMultiplier) || 1.0;

			for (let i = 0; i < uniqueEntries.length; i += 8) {
				const chunk = uniqueEntries.slice(i, i + 8);
				const results = await Promise.all(
					chunk.map(async (entry) => {
						if (secretPattern && !secretPattern.test(entry.secret)) {
							return {
								entry,
								success: false,
								duplicate: false,
								errorCode: "invalid_secret_format",
							};
						}

						const body: Record<string, unknown> = {
							provider_id: draft.provider_id,
							secret: entry.secret,
							isEnabled: draft.isEnabled ? 1 : 0,
							priceMultiplier,
						};
						if (quota != null) body.quota = quota;

						try {
							const res = await fetch("/api/credentials", {
								method: "POST",
								headers,
								body: JSON.stringify(body),
							});
							const data = (await res.json().catch(() => null)) as {
								error?: { code?: string };
							} | null;
							const errorCode = res.ok
								? null
								: (data?.error?.code ?? "unknown_error");
							return {
								entry,
								success: res.ok,
								duplicate: errorCode === "credential_duplicate",
								errorCode,
							};
						} catch (error) {
							console.error(error);
							return {
								entry,
								success: false,
								duplicate: false,
								errorCode: "network_error",
							};
						}
					}),
				);

				for (const result of results) {
					if (result.success) imported += 1;
					else if (result.duplicate) duplicateCount += 1;
					else {
						failures.push(result.entry);
						const errorCode = result.errorCode ?? "unknown_error";
						failureCounts.set(
							errorCode,
							(failureCounts.get(errorCode) ?? 0) + 1,
						);
					}
				}
				setImportProgress({
					done:
						inputDuplicateCount +
						Math.min(i + chunk.length, uniqueEntries.length),
					total: entries.length,
				});
			}

			if (imported > 0) refetch();
			setBulkSecrets(failures.map((entry) => entry.secret).join("\n"));

			const summary = t("credentials.bulk_result", {
				imported,
				failed: failures.length,
				duplicates: duplicateCount,
			});
			if (failures.length > 0) {
				const lineNumbers = failures
					.slice(0, 20)
					.map((entry) => entry.line)
					.join(", ");
				const suffix =
					failures.length > 20
						? ` (${t("credentials.bulk_failed_lines", { lines: lineNumbers })}…)`
						: ` (${t("credentials.bulk_failed_lines", { lines: lineNumbers })})`;
				const [
					topErrorCode = "unknown_error",
					topErrorCount = failures.length,
				] = [...failureCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
				const reason = t(`errors.${topErrorCode}`, {
					defaultValue:
						topErrorCode === "network_error"
							? t("credentials.bulk_network_error")
							: t("common.error"),
				});
				const reasonSuffix = t("credentials.bulk_failure_reason", {
					count: topErrorCount,
					reason,
				});
				toast.error(`${summary}${suffix} ${reasonSuffix}`, {
					id: tid,
					duration: 10000,
				});
			} else {
				toast.success(summary, { id: tid });
				setIsAddOpen(false);
			}
		} catch (error) {
			console.error(error);
			toast.error(t("common.error"), { id: tid });
		} finally {
			setIsImporting(false);
			setShowPassword(false);
		}
	};

	const openAddModal = (bulk: boolean) => {
		const pid = providers[0]?.id ?? "openrouter";
		const isSub = providers.find((p) => p.id === pid)?.isSubscription ?? false;
		setDraft({
			provider_id: pid,
			secret: "",
			quota: "",
			isEnabled: true,
			priceMultiplier: isSub ? "0.1" : "0.5",
		});
		setIsBulkImport(bulk);
		setBulkSecrets("");
		setImportProgress({ done: 0, total: 0 });
		setPriceMultiplierTouched(false);
		setShowPassword(false);
		setIsAddOpen(true);
	};

	const handleUpdateQuota = async (id: string) => {
		const tid = toast.loading(t("common.loading"));
		try {
			const res = await fetch(`/api/credentials/${id}/quota`, {
				method: "PATCH",
				headers: await getHeaders(),
				body: JSON.stringify({
					quota: Number.parseFloat(editQuota) || 0,
				}),
			});
			const data = await res.json();
			if (res.ok) {
				setEditingId(null);
				refetch();
				toast.success(t("common.success"), { id: tid });
			} else {
				toastApiError(data, t, tid);
			}
		} catch (err) {
			console.error(err);
			toast.error(t("common.error"), { id: tid });
		}
	};

	const handleRefreshQuota = async (id: string) => {
		setRefreshingQuotaId(id);
		try {
			const res = await fetch(`/api/credentials/${id}/quota`, {
				headers: await getHeaders(),
			});
			if (res.ok) {
				refetch();
				toast.success(t("common.success"));
			} else {
				const data = await res.json();
				toastApiError(data, t);
			}
		} catch (err) {
			console.error(err);
			toast.error(t("common.error"));
		} finally {
			setRefreshingQuotaId(null);
		}
	};

	const handleUpdateSettings = async (
		id: string,
		isEnabled: boolean,
		priceMultiplier: number,
	) => {
		const tid = toast.loading(t("common.loading"));
		try {
			const res = await fetch(`/api/credentials/${id}/settings`, {
				method: "PATCH",
				headers: await getHeaders(),
				body: JSON.stringify({ isEnabled: isEnabled ? 1 : 0, priceMultiplier }),
			});
			const data = await res.json();
			if (res.ok) {
				refetch();
				toast.success(t("common.success"), { id: tid });
			} else {
				toastApiError(data, t, tid);
			}
		} catch (err) {
			console.error(err);
			toast.error(t("common.error"), { id: tid });
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirm(`${t("common.confirm")}?`)) return;
		const tid = toast.loading(t("common.loading"));
		try {
			const res = await fetch(`/api/credentials/${id}`, {
				method: "DELETE",
				headers: await getHeaders(),
			});
			if (res.ok) {
				setSelectedCredentialIds((current) => {
					const next = new Set(current);
					next.delete(id);
					return next;
				});
				refetch();
				toast.success(t("common.success"), { id: tid });
			} else {
				toast.error(t("common.error"), { id: tid });
			}
		} catch (err) {
			console.error(err);
			toast.error(t("common.error"), { id: tid });
		}
	};

	const toggleCredentialSelection = (id: string) => {
		setSelectedCredentialIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleProviderExpansion = (providerId: string) => {
		setExpandedProviders((current) => {
			const next = new Set(current);
			if (next.has(providerId)) next.delete(providerId);
			else next.add(providerId);
			return next;
		});
	};

	const toggleProviderSelection = (groupCredentials: CredentialInfo[]) => {
		setSelectedCredentialIds((current) => {
			const next = new Set(current);
			const allSelected = groupCredentials.every((credential) =>
				current.has(credential.id),
			);
			for (const credential of groupCredentials) {
				if (allSelected) next.delete(credential.id);
				else next.add(credential.id);
			}
			return next;
		});
	};

	const toggleSelectAllCredentials = () => {
		setSelectedCredentialIds(
			allCredentialsSelected
				? new Set()
				: new Set(credentials.map((credential) => credential.id)),
		);
	};

	const handleDeleteSelected = async () => {
		if (selectedCredentials.length === 0 || isDeletingSelected) return;
		if (
			!confirm(
				t("credentials.bulk_delete_confirm", {
					count: selectedCredentials.length,
				}),
			)
		) {
			return;
		}

		setIsDeletingSelected(true);
		const tid = toast.loading(t("common.loading"));
		try {
			const headers = await getHeaders();
			const results: { id: string; success: boolean }[] = [];
			for (let i = 0; i < selectedCredentials.length; i += 8) {
				const chunk = selectedCredentials.slice(i, i + 8);
				const chunkResults = await Promise.all(
					chunk.map(async (credential) => {
						try {
							const res = await fetch(`/api/credentials/${credential.id}`, {
								method: "DELETE",
								headers,
							});
							return { id: credential.id, success: res.ok };
						} catch (error) {
							console.error(error);
							return { id: credential.id, success: false };
						}
					}),
				);
				results.push(...chunkResults);
			}
			const deletedIds = results
				.filter((result) => result.success)
				.map((result) => result.id);
			const failedCount = results.length - deletedIds.length;

			if (deletedIds.length > 0) {
				setSelectedCredentialIds((current) => {
					const next = new Set(current);
					for (const id of deletedIds) next.delete(id);
					return next;
				});
				refetch();
			}

			const message = t("credentials.bulk_delete_result", {
				deleted: deletedIds.length,
				failed: failedCount,
			});
			if (failedCount > 0) toast.error(message, { id: tid });
			else toast.success(message, { id: tid });
		} catch (error) {
			console.error(error);
			toast.error(t("common.error"), { id: tid });
		} finally {
			setIsDeletingSelected(false);
		}
	};

	const handleCheckAllHealth = async () => {
		if (isCheckingHealth || credentials.length === 0) return;
		setIsCheckingHealth(true);
		const tid = toast.loading(t("common.loading"));
		try {
			const res = await fetch("/api/credentials/health-check", {
				method: "POST",
				headers: await getHeaders(),
			});
			const data = await res.json();
			if (!res.ok) {
				toastApiError(data, t, tid);
				return;
			}
			refetch();
			toast.success(
				t("credentials.health_check_result", {
					healthy: data.healthy,
					degraded: data.degraded,
					skipped: data.skipped,
					failed: data.failed,
				}),
				{ id: tid, duration: 8000 },
			);
		} catch (error) {
			console.error(error);
			toast.error(t("common.error"), { id: tid });
		} finally {
			setIsCheckingHealth(false);
		}
	};

	const isSubscription = (cred: CredentialInfo) =>
		providers.find((p) => p.id === cred.provider_id)?.isSubscription ?? false;

	const formatQuota = (cred: CredentialInfo) => {
		if (isSubscription(cred)) return t("credentials.subscription");
		if (cred.quota == null) return t("credentials.no_quota");
		return formatUSD(cred.quota);
	};

	return (
		<div>
			<div className="sm:flex sm:items-center">
				<div className="sm:flex-auto">
					<h1 className="text-xl font-semibold text-gray-900 dark:text-white">
						{t("credentials.title")}
					</h1>
					<p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
						{t("credentials.subtitle")}
					</p>
				</div>
				<div className="mt-4 flex flex-wrap gap-2 sm:ml-16 sm:mt-0 sm:flex-none">
					<Button
						variant="secondary"
						onClick={handleCheckAllHealth}
						disabled={loading || isCheckingHealth || credentials.length === 0}
					>
						<ArrowPathIcon
							aria-hidden="true"
							className={`-ml-0.5 size-5 ${isCheckingHealth ? "animate-spin" : ""}`}
						/>
						{isCheckingHealth
							? t("credentials.health_checking")
							: t("credentials.health_check_all")}
					</Button>
					<Button onClick={() => openAddModal(false)}>
						<PlusIcon aria-hidden="true" className="-ml-0.5 size-5" />
						{t("credentials.add_new")}
					</Button>
					<Button variant="secondary" onClick={() => openAddModal(true)}>
						<ArrowUpTrayIcon aria-hidden="true" className="-ml-0.5 size-5" />
						{t("credentials.bulk_import")}
					</Button>
				</div>
			</div>

			{/* Promo Banner */}
			<PromoBanner
				id="byok"
				title={t("credentials.promo_title")}
				description={t("credentials.promo_desc")}
			/>

			<Modal
				open={isAddOpen}
				onClose={() => {
					if (isImporting) return;
					setIsAddOpen(false);
					setShowPassword(false);
					setPriceMultiplierTouched(false);
				}}
				title={
					isBulkImport ? t("credentials.bulk_import") : t("credentials.add_new")
				}
				size="xl"
			>
				<form onSubmit={handleAdd} className="space-y-4">
					{/* Row 1: Provider selector */}
					<div className="w-full sm:w-64">
						<label
							htmlFor="provider"
							className="block text-sm font-medium text-gray-700 dark:text-gray-300"
						>
							{t("credentials.provider")}
						</label>
						<div className="mt-1">
							<ProviderSelect
								id="provider"
								providers={providers}
								value={draft.provider_id}
								onChange={(newId) => {
									const isSub =
										providers.find((p) => p.id === newId)?.isSubscription ??
										false;
									setDraft((d) => ({
										...d,
										provider_id: newId,
										...(!priceMultiplierTouched && {
											priceMultiplier: isSub ? "0.1" : "0.5",
										}),
									}));
								}}
							/>
						</div>
					</div>

					{/* Guidance panel */}
					{guide && (
						<GuidancePanel
							guide={guide}
							providerId={draft.provider_id}
							isOAuth={isOAuth}
							open={guideOpen}
							onToggle={() => setGuideOpen(!guideOpen)}
						/>
					)}

					{/* Row 2: Secret input */}
					<div>
						<div className="mb-1 flex items-center justify-between">
							<label
								htmlFor={isBulkImport ? "bulk-secrets" : "secret"}
								className="block text-sm font-medium text-gray-700 dark:text-gray-300"
							>
								{t("credentials.secret")}
							</label>
							<button
								type="button"
								onClick={() => setShowPassword(!showPassword)}
								className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
								aria-label={
									showPassword ? t("common.hide") : t("common.reveal")
								}
							>
								{showPassword ? (
									<EyeSlashIcon className="size-5" />
								) : (
									<EyeIcon className="size-5" />
								)}
							</button>
						</div>
						{isBulkImport ? (
							<>
								<textarea
									id="bulk-secrets"
									required
									rows={6}
									value={
										showPassword
											? bulkSecrets
											: bulkSecrets
													.split(/\r?\n/)
													.map((line) => "•".repeat(Math.min(line.length, 40)))
													.join("\n")
									}
									onChange={(e) => {
										if (showPassword) setBulkSecrets(e.target.value);
									}}
									onFocus={() => {
										if (!showPassword) setShowPassword(true);
									}}
									onPaste={(e) => {
										if (!showPassword) {
											e.preventDefault();
											setBulkSecrets(e.clipboardData.getData("text"));
											setShowPassword(true);
										}
									}}
									disabled={isImporting}
									className="block w-full rounded-lg border border-gray-200 bg-white py-2 px-3 font-mono text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-gray-500"
									placeholder={t("credentials.bulk_placeholder")}
								/>
								<div className="mt-2">
									<button
										type="button"
										disabled={isImporting || !bulkSecrets.trim()}
										onClick={() => {
											const lines = bulkSecrets
												.split(/\r?\n/)
												.map((line) => line.trim())
												.filter(Boolean);
											const uniqueLines = [...new Set(lines)];
											const removed = lines.length - uniqueLines.length;
											setBulkSecrets(uniqueLines.join("\n"));
											toast.success(
												t("credentials.bulk_deduplicated", { count: removed }),
											);
										}}
										className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
									>
										{t("credentials.remove_duplicates")}
									</button>
								</div>
								<p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
									{t("credentials.bulk_hint")}
								</p>
								{isImporting && (
									<p className="text-xs text-gray-500 dark:text-gray-400">
										{t("credentials.bulk_progress", importProgress)}
									</p>
								)}
							</>
						) : (
							<div className="relative mt-1">
								{isOAuth ? (
									<textarea
										id="secret"
										required
										rows={showPassword ? 4 : 1}
										value={
											showPassword
												? draft.secret
												: draft.secret
													? "\u2022".repeat(Math.min(draft.secret.length, 40))
													: ""
										}
										onChange={(e) => {
											if (showPassword)
												setDraft({ ...draft, secret: e.target.value });
										}}
										onFocus={() => {
											if (!showPassword) setShowPassword(true);
										}}
										onPaste={(e) => {
											if (!showPassword) {
												e.preventDefault();
												const text = e.clipboardData.getData("text");
												setDraft({ ...draft, secret: text });
												setShowPassword(true);
											}
										}}
										className="block w-full rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-10 font-mono text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-white/10 dark:bg-white/5 dark:text-white dark:placeholder:text-gray-500 resize-none"
										placeholder={guide?.placeholder ?? "refresh_token or JSON"}
									/>
								) : (
									<Input
										type={showPassword ? "text" : "password"}
										id="secret"
										required
										value={draft.secret}
										onChange={(e) =>
											setDraft({ ...draft, secret: e.target.value })
										}
										className="pr-10"
										placeholder={guide?.placeholder ?? "sk-..."}
									/>
								)}
							</div>
						)}
						{/* Smart format detection hint */}
						{!isBulkImport && secretHint.type && (
							<p
								className={`mt-1.5 flex items-center gap-1 text-xs ${
									secretHint.type === "json"
										? TOKENS.green.text
										: TOKENS.amber.text
								}`}
							>
								<InformationCircleIcon className="size-4 shrink-0" />
								{secretHint.message}
							</p>
						)}
					</div>

					{/* Row 3: Quota + Price Multiplier side by side */}
					<div className="flex flex-col sm:flex-row gap-4">
						{needsManualQuota && (
							<div className="w-full sm:w-40">
								<label
									htmlFor="quota"
									className="block text-sm font-medium text-gray-700 dark:text-gray-300"
								>
									{t("credentials.quota")}
								</label>
								<Input
									type="number"
									id="quota"
									min="0"
									step="0.01"
									value={draft.quota}
									onChange={(e) =>
										setDraft({ ...draft, quota: e.target.value })
									}
									className="mt-1"
									placeholder="10.00"
								/>
							</div>
						)}
						<div className="w-full sm:w-56">
							<label
								htmlFor="priceMultiplier"
								className="block text-sm font-medium text-gray-700 dark:text-gray-300"
							>
								{t("credentials.price_multiplier")}
							</label>
							<Input
								type="number"
								id="priceMultiplier"
								min="0.01"
								max="1"
								step="0.01"
								required
								value={draft.priceMultiplier}
								onChange={(e) => {
									setDraft({ ...draft, priceMultiplier: e.target.value });
									setPriceMultiplierTouched(true);
								}}
								className="mt-1"
								placeholder="0.8"
							/>
							{draft.priceMultiplier && (
								<p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
									{t("credentials.price_multiplier_helper", {
										ratio: draft.priceMultiplier,
										credited: (
											1.0 * (Number.parseFloat(draft.priceMultiplier) || 0)
										).toFixed(2),
									})}
								</p>
							)}
						</div>
					</div>

					{/* Row 4: Actions */}
					<div className="flex justify-end gap-3 pt-1">
						<Button
							variant="secondary"
							disabled={isImporting}
							onClick={() => {
								setIsAddOpen(false);
								setShowPassword(false);
								setPriceMultiplierTouched(false);
							}}
						>
							{t("common.cancel")}
						</Button>
						<Button type="submit" disabled={isImporting}>
							{isImporting
								? t("credentials.bulk_progress", importProgress)
								: isBulkImport
									? t("credentials.bulk_import")
									: t("common.save")}
						</Button>
					</div>
				</form>
			</Modal>

			{selectedCredentials.length > 0 && (
				<div className="mt-6 flex items-center justify-between gap-3">
					<span className="text-sm text-gray-600 dark:text-gray-300">
						{t("credentials.selected_count", {
							count: selectedCredentials.length,
						})}
					</span>
					<Button
						variant="secondary"
						onClick={handleDeleteSelected}
						disabled={isDeletingSelected}
					>
						{isDeletingSelected
							? t("common.loading")
							: t("credentials.delete_selected")}
					</Button>
				</div>
			)}

			<div className="mt-8 flow-root">
				<div className="-mx-4 -my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
					<div className="inline-block min-w-full py-2 align-middle sm:px-6 lg:px-8">
						<div className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/10">
							<table className="min-w-full divide-y divide-gray-200 dark:divide-white/10">
								<thead className="bg-gray-50 dark:bg-white/5">
									<tr>
										<th scope="col" className="py-3.5 pl-4 pr-2 sm:pl-6">
											<input
												ref={selectAllRef}
												type="checkbox"
												checked={allCredentialsSelected}
												onChange={toggleSelectAllCredentials}
												disabled={loading || credentials.length === 0}
												aria-label={t("credentials.select_all")}
												className="size-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-white/20 dark:bg-gray-900"
											/>
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.provider")}
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.secret")}
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.quota")}
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.price_multiplier")}
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.earnings")}
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.added")}
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.health")}
										</th>
										<th
											scope="col"
											className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900 dark:text-white"
										>
											{t("credentials.enabled")}
										</th>
										<th
											scope="col"
											className="relative py-3.5 pl-3 pr-4 sm:pr-6"
										>
											<span className="sr-only">{t("common.actions")}</span>
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-200 bg-white dark:divide-white/10 dark:bg-gray-900">
									{loading ? (
										Array.from({ length: 4 }).map((_, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
											<tr key={i}>
												<td className="py-4 pl-4 pr-2 sm:pl-6">
													<div className="size-4 rounded border border-gray-200 bg-gray-100 dark:border-white/10 dark:bg-white/5" />
												</td>
												<td className="py-4 pl-4 sm:pl-6">
													<div className="flex items-center gap-2">
														<div className="size-5 rounded-full bg-gray-200 dark:bg-white/10 animate-pulse" />
														<div className="h-4 w-20 rounded bg-gray-200 dark:bg-white/10 animate-pulse" />
													</div>
												</td>
												<td className="px-3 py-4">
													<div className="h-4 w-36 rounded bg-gray-100 dark:bg-white/5 animate-pulse" />
												</td>
												<td className="px-3 py-4">
													<div className="h-5 w-14 rounded-full bg-gray-100 dark:bg-white/5 animate-pulse" />
												</td>
												<td className="px-3 py-4">
													<div className="h-4 w-16 rounded bg-gray-100 dark:bg-white/5 animate-pulse" />
												</td>
												<td className="px-3 py-4 hidden sm:table-cell" />
												<td className="px-3 py-4 hidden sm:table-cell" />
												<td className="px-3 py-4 hidden lg:table-cell" />
												<td className="px-3 py-4" />
												<td className="py-4 pl-3 pr-4 sm:pr-6" />
											</tr>
										))
									) : credentials.length === 0 ? (
										<tr>
											<td
												colSpan={10}
												className="py-4 text-center text-sm text-gray-500 dark:text-gray-400"
											>
												{t("credentials.no_data")}
											</td>
										</tr>
									) : (
										credentialGroups.map(([providerId, groupCredentials]) => {
											const selectedCount = groupCredentials.filter(
												(credential) =>
													selectedCredentialIds.has(credential.id),
											).length;
											const healthCounts: Record<HealthStatus, number> = {
												ok: 0,
												degraded: 0,
												dead: 0,
												cooldown: 0,
											};
											for (const credential of groupCredentials) {
												healthCounts[credential.health] += 1;
											}
											const groupExpanded = expandedProviders.has(providerId);
											const providerMeta = providers.find(
												(provider) => provider.id === providerId,
											);

											return (
												<Fragment key={providerId}>
													<tr className="bg-gray-50/70 dark:bg-white/[0.03]">
														<td className="py-4 pl-4 pr-2 sm:pl-6">
															<input
																type="checkbox"
																checked={
																	selectedCount === groupCredentials.length
																}
																onChange={() =>
																	toggleProviderSelection(groupCredentials)
																}
																aria-label={t("credentials.select_provider", {
																	provider: providerMeta?.name ?? providerId,
																})}
																className="size-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-white/20 dark:bg-gray-900"
															/>
														</td>
														<td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6 dark:text-white">
															<button
																type="button"
																onClick={() =>
																	toggleProviderExpansion(providerId)
																}
																aria-expanded={groupExpanded}
																className="flex items-center gap-2 text-left"
															>
																{groupExpanded ? (
																	<ChevronUpIcon className="size-4 shrink-0 text-gray-400" />
																) : (
																	<ChevronDownIcon className="size-4 shrink-0 text-gray-400" />
																)}
																{providerMeta ? (
																	<ProviderChip
																		src={providerMeta.logoUrl}
																		name={providerMeta.name}
																	/>
																) : (
																	<span>{providerId}</span>
																)}
																<span className="text-xs font-normal text-gray-500 dark:text-gray-400">
																	{t("credentials.key_count", {
																		count: groupCredentials.length,
																	})}
																</span>
															</button>
														</td>
														<td
															colSpan={5}
															className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400"
														>
															{t("credentials.provider_earnings", {
																earnings: formatUSD(
																	groupCredentials.reduce(
																		(total, credential) =>
																			total + credential.earnings,
																		0,
																	),
																),
															})}
														</td>
														<td className="px-3 py-4">
															<div className="flex flex-wrap gap-1.5">
																{(
																	[
																		"ok",
																		"degraded",
																		"cooldown",
																		"dead",
																	] as const
																).map((status) => (
																	<HealthBadgeCount
																		key={status}
																		status={status}
																		count={healthCounts[status]}
																	/>
																))}
															</div>
														</td>
														<td className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
															{t("credentials.enabled_count", {
																enabled: groupCredentials.filter(
																	(credential) => credential.isEnabled,
																).length,
																total: groupCredentials.length,
															})}
														</td>
														<td className="py-4 pl-3 pr-4 sm:pr-6" />
													</tr>
													{groupExpanded &&
														groupCredentials.map((cred) => (
															<tr
																key={cred.id}
																className={cred.isEnabled ? "" : "opacity-50"}
															>
																<td className="py-4 pl-4 pr-2 sm:pl-6">
																	<input
																		type="checkbox"
																		checked={selectedCredentialIds.has(cred.id)}
																		onChange={() =>
																			toggleCredentialSelection(cred.id)
																		}
																		aria-label={t(
																			"credentials.select_credential",
																			{
																				credential: cred.secretHint,
																			},
																		)}
																		className="size-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-white/20 dark:bg-gray-900"
																	/>
																</td>
																<td className="py-4 pl-4 pr-3 sm:pl-6" />
																{/* Secret */}
																<td className="whitespace-nowrap px-3 py-4 text-sm font-mono text-gray-500 dark:text-gray-400">
																	<div className="flex items-center gap-2">
																		{cred.secretHint}
																		<button
																			type="button"
																			onClick={() => {
																				navigator.clipboard.writeText(
																					cred.secretHint,
																				);
																				toast.success("Copied to clipboard");
																			}}
																			className="text-gray-400 hover:text-brand-500"
																			title="Copy hint"
																		>
																			<ClipboardDocumentIcon className="size-4" />
																		</button>
																	</div>
																</td>
																{/* Quota */}
																<td className="whitespace-nowrap px-3 py-4 text-sm">
																	{editingId === cred.id ? (
																		<div className="flex items-center gap-2">
																			<input
																				type="number"
																				min="0"
																				step="0.01"
																				value={editQuota}
																				onChange={(e) =>
																					setEditQuota(e.target.value)
																				}
																				className="w-20 rounded-lg border border-gray-200 bg-white py-1 px-2 text-sm text-gray-900 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-white/10 dark:bg-white/5 dark:text-white"
																			/>
																			<button
																				type="button"
																				onClick={() =>
																					handleUpdateQuota(cred.id)
																				}
																				className={`${TOKENS.green.text} ${TOKENS.green.textHover}`}
																				title={t("common.save")}
																			>
																				<CheckIcon className="size-5" />
																			</button>
																			<button
																				type="button"
																				onClick={() => setEditingId(null)}
																				className={`${TOKENS.red.text} ${TOKENS.red.textHover}`}
																				title={t("common.cancel")}
																			>
																				<XMarkIcon className="size-5" />
																			</button>
																		</div>
																	) : (
																		<span
																			className={`font-mono flex items-center ${
																				isSubscription(cred)
																					? "text-brand-500 dark:text-brand-400"
																					: cred.quota == null
																						? "text-gray-400 dark:text-gray-500"
																						: cred.quota > 0
																							? TOKENS.green.text
																							: TOKENS.red.text
																			}`}
																		>
																			{formatQuota(cred)}
																			{cred.quotaSource === "auto" && (
																				<button
																					type="button"
																					disabled={
																						refreshingQuotaId === cred.id
																					}
																					onClick={() =>
																						handleRefreshQuota(cred.id)
																					}
																					className="ml-2 text-gray-400 hover:text-brand-500 disabled:opacity-50"
																					title={t("credentials.refresh_quota")}
																				>
																					<ArrowPathIcon
																						className={`size-4 ${refreshingQuotaId === cred.id ? "animate-spin" : ""}`}
																					/>
																				</button>
																			)}
																			{cred.quotaSource === "manual" && (
																				<button
																					type="button"
																					onClick={() => {
																						setEditingId(cred.id);
																						setEditQuota(
																							(cred.quota ?? 0).toString(),
																						);
																					}}
																					className="ml-2 text-gray-400 hover:text-brand-500"
																					title={t("common.edit")}
																				>
																					<PencilSquareIcon className="size-4" />
																				</button>
																			)}
																		</span>
																	)}
																</td>
																{/* Price Multiplier */}
																<td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
																	{editingSettingsId === cred.id ? (
																		<div className="flex items-center gap-2">
																			<input
																				type="number"
																				min="0.01"
																				max="1"
																				step="0.01"
																				value={editPriceMultiplier}
																				onChange={(e) =>
																					setEditPriceMultiplier(e.target.value)
																				}
																				className="w-16 rounded-lg border border-gray-200 bg-white py-1 px-1 text-sm text-gray-900 transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-white/10 dark:bg-white/5 dark:text-white"
																			/>
																			<button
																				type="button"
																				onClick={() => {
																					handleUpdateSettings(
																						cred.id,
																						cred.isEnabled,
																						Number.parseFloat(
																							editPriceMultiplier,
																						),
																					);
																					setEditingSettingsId(null);
																				}}
																				className={`${TOKENS.green.text} ${TOKENS.green.textHover}`}
																				title={t("common.save")}
																			>
																				<CheckIcon className="size-5" />
																			</button>
																			<button
																				type="button"
																				onClick={() =>
																					setEditingSettingsId(null)
																				}
																				className={`${TOKENS.red.text} ${TOKENS.red.textHover}`}
																				title={t("common.cancel")}
																			>
																				<XMarkIcon className="size-5" />
																			</button>
																		</div>
																	) : (
																		<div className="flex items-center font-mono text-gray-900 dark:text-white">
																			{cred.priceMultiplier}x
																			<button
																				type="button"
																				onClick={() => {
																					setEditingSettingsId(cred.id);
																					setEditPriceMultiplier(
																						cred.priceMultiplier.toString(),
																					);
																				}}
																				className="ml-2 text-gray-400 hover:text-brand-500"
																				title={t("common.edit")}
																			>
																				<PencilSquareIcon className="size-4" />
																			</button>
																		</div>
																	)}
																</td>
																{/* Earnings */}
																<td className="whitespace-nowrap px-3 py-4 text-sm font-mono text-gray-900 dark:text-white">
																	{formatUSD(cred.earnings)}
																</td>
																{/* Added */}
																<td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
																	{formatDateTime(cred.addedAt)}
																</td>
																{/* Health */}
																<td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
																	<HealthBadge status={cred.health} />
																</td>
																{/* Enabled */}
																<td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
																	<ToggleSwitch
																		enabled={cred.isEnabled}
																		onChange={(val) =>
																			handleUpdateSettings(
																				cred.id,
																				val,
																				cred.priceMultiplier,
																			)
																		}
																		label={t(
																			cred.isEnabled
																				? "credentials.enabled_true"
																				: "credentials.enabled_false",
																		)}
																	/>
																</td>
																{/* Actions */}
																<td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
																	<button
																		type="button"
																		onClick={() => handleDelete(cred.id)}
																		className={`${TOKENS.red.text} ${TOKENS.red.textHover}`}
																	>
																		{t("common.delete")}
																	</button>
																</td>
															</tr>
														))}
												</Fragment>
											);
										})
									)}
								</tbody>
							</table>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Guidance Panel ─────────────────────────────────────

function HealthBadgeCount({
	status,
	count,
}: {
	status: HealthStatus;
	count: number;
}) {
	return (
		<span className="inline-flex items-center gap-1">
			<HealthBadge status={status} />
			<span className="text-xs font-medium text-gray-600 dark:text-gray-300">
				{count}
			</span>
		</span>
	);
}

function GuidancePanel({
	guide,
	providerId,
	isOAuth,
	open,
	onToggle,
}: {
	guide: CredentialGuide;
	providerId: string;
	isOAuth: boolean;
	open: boolean;
	onToggle: () => void;
}) {
	const { t } = useTranslation();

	const steps = t(`credentials.guide_steps.${providerId}`, {
		returnObjects: true,
		defaultValue: [],
	}) as string[];

	const copyToClipboard = (text: string) => {
		navigator.clipboard.writeText(text);
		toast.success(t("credentials.copied"));
	};

	if (!steps.length || (!isOAuth && steps.length <= 1)) return null;

	return (
		<div className="rounded-lg border border-brand-100 bg-brand-50/50 dark:border-brand-500/20 dark:bg-brand-500/5">
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/10"
			>
				<span className="flex items-center gap-1.5">
					<InformationCircleIcon className="size-4" />
					{t("credentials.guide_title")}
				</span>
				{open ? (
					<ChevronUpIcon className="size-4" />
				) : (
					<ChevronDownIcon className="size-4" />
				)}
			</button>

			{open && (
				<div className="px-3 pb-3 space-y-2">
					<ol className="list-none space-y-1.5">
						{steps.map((step, idx) => (
							<li
								key={step}
								className="flex gap-2 text-sm text-gray-700 dark:text-gray-300"
							>
								<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
									{idx + 1}
								</span>
								<span>
									<LinkifiedText text={step} />
								</span>
							</li>
						))}
					</ol>

					{guide.command &&
						(Array.isArray(guide.command)
							? guide.command
							: [guide.command]
						).map((cmd) => (
							<CopyableCommand
								key={cmd}
								command={cmd}
								onCopy={copyToClipboard}
							/>
						))}

					{guide.filePath && (
						<div className="flex items-center justify-between gap-2">
							<p className="text-xs text-gray-500 dark:text-gray-400">
								{t("credentials.guide_file_location")}{" "}
								<code className="rounded bg-gray-200 px-1 py-0.5 font-mono text-gray-700 dark:bg-white/10 dark:text-gray-300">
									{guide.filePath}
								</code>
							</p>
							<CopyPromptButton providerId={providerId} />
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function LinkifiedText({ text }: { text: string }) {
	const parts = text.split(/(https?:\/\/[^\s)]+)/);
	if (parts.length === 1) return <>{text}</>;
	return (
		<>
			{parts.map((part) =>
				part.match(/^https?:\/\//) ? (
					<a
						key={part}
						href={part}
						target="_blank"
						rel="noopener noreferrer"
						className="text-brand-600 hover:text-brand-500 dark:text-brand-400 dark:hover:text-brand-300 underline"
					>
						{part}
					</a>
				) : (
					part
				),
			)}
		</>
	);
}

function CopyPromptButton({ providerId }: { providerId: string }) {
	const { t } = useTranslation();
	const [hover, setHover] = useState(false);
	const [pos, setPos] = useState({ x: 0, y: 0 });

	const prompt = t(`credentials.copy_prompt_text.${providerId}`);

	const onMove = useCallback((e: React.MouseEvent) => {
		setPos({ x: e.clientX, y: e.clientY });
	}, []);

	return (
		<>
			<button
				type="button"
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				onMouseMove={onMove}
				onClick={() => {
					navigator.clipboard.writeText(prompt);
					toast.success(t("credentials.copied"));
				}}
				className={`shrink-0 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors ${TOKENS.amber.outline} ${TOKENS.amber.softHover}`}
			>
				<ClipboardDocumentIcon className="size-3.5" />
				{t("credentials.copy_prompt")}
			</button>
			{hover && (
				<div
					className="fixed z-50 max-w-xs rounded-lg bg-gray-900 px-3 py-2.5 text-xs shadow-xl pointer-events-none"
					style={{ left: pos.x + 14, top: pos.y + 14 }}
				>
					<p className="font-medium text-amber-300 mb-1.5">
						{t("credentials.copy_prompt_tooltip")}
					</p>
					<p className="text-gray-400 whitespace-pre-wrap line-clamp-6 leading-relaxed">
						{prompt}
					</p>
				</div>
			)}
		</>
	);
}

function CopyableCommand({
	command,
	onCopy,
}: {
	command: string;
	onCopy: (text: string) => void;
}) {
	return (
		<div className="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 font-mono text-xs text-gray-100 dark:bg-black/40">
			<CommandLineIcon className="size-4 shrink-0 text-gray-400" />
			<code className="flex-1 select-all truncate">{command}</code>
			<button
				type="button"
				onClick={() => onCopy(command)}
				className="shrink-0 text-gray-400 hover:text-white transition-colors"
				title="Copy"
			>
				<ClipboardDocumentIcon className="size-4" />
			</button>
		</div>
	);
}
