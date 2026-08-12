import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, UserPlus, UserMinus, X } from 'lucide-react';
import {
  listAllGroups,
  getGroup,
  patchGroup,
  findUserByEmail,
  hasAvailableScimGroupMembershipEvidence,
  listAllUsers,
  parseScimGroupMembers,
  type ScimListResponse,
} from '@/services/omniApi';
import { buildGroupMembershipPatch } from '@/services/userManagement/bulkIdentityImport';
import { useConnection } from '@/hooks/useConnection';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import {
  selectedBadgeClass,
  selectedCardClass,
  selectedRowClass,
  unselectedCardClass,
  unselectedRowClass,
} from '@/components/ui/selectionStyles';
import { friendlyApiError } from '@/utils/apiErrors';
import { csvRowsToText, type CsvCellValue } from '@/utils/csvExport';
import type { OmniGroup, OmniUser } from '@/types';
import { AccessPostureEvidence } from '@/components/admin/CapabilityStatus';
import { fetchAdminReadiness, type AdminAccessPosture } from '@/services/adminReadiness';

function AddMemberModal({
  open,
  groupName,
  onClose,
  onAdd,
}: {
  open: boolean;
  groupName: string;
  onClose: () => void;
  onAdd: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('#add-member-email')?.focus(), 0);
    } else {
      previousFocusRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError('');
    try {
      await onAdd(email);
      setEmail('');
      onClose();
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to add member'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-member-title"
        aria-describedby="add-member-description"
        className="relative max-h-[calc(100vh-2rem)] w-full max-w-sm overflow-y-auto rounded-card bg-white p-6 mx-4 shadow-dropdown"
      >
        <button type="button" aria-label="Close add member dialog" onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 id="add-member-title" className="text-lg font-semibold text-content-primary mb-1">Add Member</h3>
        <p id="add-member-description" className="text-xs text-content-secondary mb-4">Add a user to "{groupName}" by email.</p>
        {error && (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-3">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <label htmlFor="add-member-email" className="block text-xs font-medium text-content-secondary">Member email</label>
          <input
            id="add-member-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input-field"
            placeholder="user@example.com"
          />
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={loading || !email} className="btn-primary text-sm">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              Add Member
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function downloadCsv(fileName: string, rows: CsvCellValue[][]) {
  const csv = csvRowsToText(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function incompleteCollectionMessage(label: 'User' | 'Group', response: ScimListResponse): string {
  const included = typeof response.loadedResults === 'number'
    ? response.loadedResults
    : response.Resources?.length || 0;
  const total = typeof response.totalResults === 'number'
    ? String(response.totalResults)
    : 'an unknown total';
  return `${label} collection is incomplete: ${included} of ${total} records were loaded. Export and membership changes are blocked.`;
}

type GroupInventoryRecord = Omit<OmniGroup, 'members'> & { members?: OmniGroup['members'] };

export function GroupsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const [groups, setGroups] = useState<GroupInventoryRecord[]>([]);
  const [groupLoadState, setGroupLoadState] = useState<'not_loaded' | 'partial' | 'complete'>('not_loaded');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [detailedGroups, setDetailedGroups] = useState<Record<string, GroupInventoryRecord>>({});
  const [membershipEvidence, setMembershipEvidence] = useState<Record<string, 'available' | 'unknown' | 'failed'>>({});
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set());
  const [accessPostureByGroup, setAccessPostureByGroup] = useState<Record<string, AdminAccessPosture>>({});
  const [accessPostureErrors, setAccessPostureErrors] = useState<Record<string, string>>({});
  const [loadingAccessPostureId, setLoadingAccessPostureId] = useState('');
  const [addMemberGroup, setAddMemberGroup] = useState<GroupInventoryRecord | null>(null);
  const [removeMember, setRemoveMember] = useState<{ group: GroupInventoryRecord; memberId: string; memberName: string } | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [exportingMemberships, setExportingMemberships] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const [assignUsers, setAssignUsers] = useState<OmniUser[]>([]);
  const [assignUsersComplete, setAssignUsersComplete] = useState(false);
  const [loadingAssignUsers, setLoadingAssignUsers] = useState(false);
  const [assignUserSearch, setAssignUserSearch] = useState('');
  const [selectedAssignUserIds, setSelectedAssignUserIds] = useState<Set<string>>(new Set());
  const [bulkAssignGroupId, setBulkAssignGroupId] = useState('');
  const [assigningUsers, setAssigningUsers] = useState(false);
  const [assignResults, setAssignResults] = useState<string[]>([]);

  const fetchGroups = useCallback(async () => {
    const requestKey = connectionKey;
    setLoading(true);
    setError('');
    setGroups([]);
    setGroupLoadState('not_loaded');
    setMembershipEvidence({});
    setAssignUsers([]);
    setAssignUsersComplete(false);
    setSelectedAssignUserIds(new Set());
    setAccessPostureByGroup({});
    setAccessPostureErrors({});
    setLoadingAccessPostureId('');
    try {
      const response = await listAllGroups(connection.baseUrl, connection.apiKey, { pageSize: 100, maxPages: 200 });
      if (!isActiveConnectionRequest(requestKey)) return;
      const nextMembershipEvidence: Record<string, 'available' | 'unknown'> = {};
      const allGroups = (response.Resources || []).map((g: Record<string, unknown>) => {
          const id = g.id as string;
          const members = parseScimGroupMembers(g.members);
          const hasMembers = members !== null;
          nextMembershipEvidence[id] = hasMembers ? 'available' : 'unknown';
          return {
            id,
            displayName: g.displayName as string,
            ...(hasMembers ? { members } : {}),
          };
        });
      const partial = Boolean(response.truncated || response.error);
      setGroups(allGroups);
      setMembershipEvidence(nextMembershipEvidence);
      setGroupLoadState(partial ? (allGroups.length > 0 ? 'partial' : 'not_loaded') : 'complete');
      if (partial) {
        setError(incompleteCollectionMessage('Group', response));
      }
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to load groups'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoading(false);
    }
  }, [connection.baseUrl, connection.apiKey, connectionKey, isActiveConnectionRequest]);

  useLayoutEffect(() => {
    setGroups([]);
    setGroupLoadState('not_loaded');
    setExpandedIds(new Set());
    setDetailedGroups({});
    setMembershipEvidence({});
    setAccessPostureByGroup({});
    setAccessPostureErrors({});
    setLoadingAccessPostureId('');
    setLoadingDetailIds(new Set());
    setAddMemberGroup(null);
    setRemoveMember(null);
    setAssignUsers([]);
    setAssignUsersComplete(false);
    setSelectedAssignUserIds(new Set());
    setBulkAssignGroupId('');
    setAssignResults([]);
    setExportingMemberships(false);
    setLoadingAssignUsers(false);
    setAssigningUsers(false);
    setExportNotice('');
    setError('');
  }, [connectionKey]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  async function requireGroupMembershipDetail(
    group: GroupInventoryRecord,
    requestKey: string,
  ): Promise<OmniGroup | null> {
    const cached = detailedGroups[group.id] || group;
    const cachedMembers = parseScimGroupMembers(cached.members);
    if (membershipEvidence[group.id] === 'available' && cachedMembers !== null) {
      return { id: cached.id, displayName: cached.displayName, members: cachedMembers };
    }

    const fetched = await getGroup(connection.baseUrl, connection.apiKey, group.id);
    if (!isActiveConnectionRequest(requestKey)) return null;
    const fetchedMembers = parseScimGroupMembers(fetched.members);
    if (fetchedMembers === null) {
      setMembershipEvidence((prev) => ({ ...prev, [group.id]: 'unknown' }));
      throw new Error('Group membership evidence is unavailable.');
    }
    const detail: OmniGroup = {
      id: group.id,
      displayName: typeof fetched.displayName === 'string' ? fetched.displayName : group.displayName,
      members: fetchedMembers,
    };
    setDetailedGroups((prev) => ({ ...prev, [group.id]: detail }));
    setMembershipEvidence((prev) => ({ ...prev, [group.id]: 'available' }));
    return detail;
  }

  async function toggleExpand(groupId: string) {
    const requestKey = connectionKey;
    const next = new Set(expandedIds);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
      setBulkAssignGroupId(groupId);
      const listedGroup = groups.find((group) => group.id === groupId);
      const hasAvailableMembership = hasAvailableScimGroupMembershipEvidence(
        membershipEvidence[groupId],
        detailedGroups[groupId]?.members,
        listedGroup?.members,
      );
      if (!hasAvailableMembership) {
        setLoadingDetailIds((current) => new Set(current).add(groupId));
        try {
          const detail = await getGroup(connection.baseUrl, connection.apiKey, groupId);
          if (!isActiveConnectionRequest(requestKey)) return;
          const members = parseScimGroupMembers(detail.members);
          const hasMembers = members !== null;
          setDetailedGroups((prev) => ({
            ...prev,
            [groupId]: {
              id: detail.id,
              displayName: detail.displayName as string,
              ...(hasMembers ? { members } : {}),
            },
          }));
          setMembershipEvidence((prev) => ({ ...prev, [groupId]: hasMembers ? 'available' : 'unknown' }));
        } catch {
          if (!isActiveConnectionRequest(requestKey)) return;
          setMembershipEvidence((prev) => (
            prev[groupId] === 'available' ? prev : { ...prev, [groupId]: 'failed' }
          ));
        } finally {
          if (isActiveConnectionRequest(requestKey)) {
            setLoadingDetailIds((current) => {
              const next = new Set(current);
              next.delete(groupId);
              return next;
            });
          }
        }
      }
    }
    setExpandedIds(next);
  }

  async function handleAddMember(email: string) {
    if (!addMemberGroup) return;
    if (groupLoadState !== 'complete') {
      throw new Error('Group membership changes require complete group collection coverage. Refresh the group inventory before continuing.');
    }
    const requestKey = connectionKey;
    const targetGroup = addMemberGroup;
    const userRes = await findUserByEmail(connection.baseUrl, connection.apiKey, email);
    if (!isActiveConnectionRequest(requestKey)) return;
    const users = userRes.Resources || [];
    if (users.length !== 1) throw new Error(users.length === 0 ? 'User not found' : 'Multiple users found');

    const userId = users[0].id as string;
    const detail = await requireGroupMembershipDetail(targetGroup, requestKey);
    if (!detail) return;
    if (detail.members.some((member) => member.value === userId)) {
      throw new Error(`${email} is already a member of ${targetGroup.displayName}.`);
    }
    const updatedMembers = [...detail.members, { display: email, value: userId }];
    const patch = buildGroupMembershipPatch([{ display: email, value: userId }], []);
    if (!patch) return;
    if (!isActiveConnectionRequest(requestKey)) return;
    await patchGroup(connection.baseUrl, connection.apiKey, targetGroup.id, patch);
    if (!isActiveConnectionRequest(requestKey)) return;

    setDetailedGroups((prev) => ({
      ...prev,
      [targetGroup.id]: { ...detail, members: updatedMembers },
    }));
    fetchGroups();
  }

  async function inspectAccessPosture(groupId: string) {
    const requestKey = connectionKey;
    if (!connection.instanceId) {
      setAccessPostureErrors((prev) => ({ ...prev, [groupId]: 'Choose an active saved Omni instance before inspecting model-role assignments.' }));
      return;
    }
    setLoadingAccessPostureId(groupId);
    setAccessPostureErrors((prev) => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
    try {
      const report = await fetchAdminReadiness(connection.instanceId, 'identity', {
        principalType: 'group',
        principalId: groupId,
      });
      if (!isActiveConnectionRequest(requestKey)) return;
      if (!report.accessPosture) throw new Error('Omni returned no model-role assignment evidence.');
      setAccessPostureByGroup((prev) => ({ ...prev, [groupId]: report.accessPosture! }));
    } catch (nextError) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setAccessPostureByGroup((prev) => {
        const next = { ...prev };
        delete next[groupId];
        return next;
      });
      setAccessPostureErrors((prev) => ({
        ...prev,
        [groupId]: friendlyApiError(nextError, 'Model-role assignments could not be inspected'),
      }));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoadingAccessPostureId('');
    }
  }

  async function handleRemoveMember() {
    if (!removeMember) return;
    if (groupLoadState !== 'complete') {
      setError('Group membership changes require complete group collection coverage. Refresh the group inventory before continuing.');
      setRemoveMember(null);
      return;
    }
    const requestKey = connectionKey;
    const { group, memberId } = removeMember;

    try {
      const detail = await requireGroupMembershipDetail(group, requestKey);
      if (!detail) return;
      const updatedMembers = detail.members.filter((m) => m.value !== memberId);
      const patch = buildGroupMembershipPatch([], [memberId]);
      if (!patch) return;
      await patchGroup(connection.baseUrl, connection.apiKey, group.id, patch);
      if (!isActiveConnectionRequest(requestKey)) return;
      setDetailedGroups((prev) => ({
        ...prev,
        [group.id]: { ...detail, members: updatedMembers },
      }));
      fetchGroups();
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to remove member'));
    }
    if (isActiveConnectionRequest(requestKey)) setRemoveMember(null);
  }

  async function handleDownloadGroupAssignments() {
    if (groupLoadState !== 'complete') {
      setError('Group membership export requires complete group collection coverage. Refresh the group inventory before continuing.');
      return;
    }
    const requestKey = connectionKey;
    setExportingMemberships(true);
    setError('');
    const rows: string[][] = [['record_type', 'action', 'email', 'display_name', 'group_name']];

    try {
      const usersResponse = await listAllUsers(connection.baseUrl, connection.apiKey, { pageSize: 100, maxPages: 200 });
      if (!isActiveConnectionRequest(requestKey)) return;
      if (usersResponse.error || usersResponse.truncated) {
        throw new Error(incompleteCollectionMessage('User', usersResponse));
      }
      const emailByUserId = new Map(
        (usersResponse.Resources || []).flatMap((user) => (
          typeof user.id === 'string' && typeof user.userName === 'string'
            ? [[user.id, user.userName] as const]
            : []
        )),
      );
      let unresolvedMemberships = 0;
      for (const group of groups) {
        const detail = await requireGroupMembershipDetail(group, requestKey);
        if (!detail) return;
        rows.push(['group', 'ensure', '', '', group.displayName]);
        for (const member of detail.members) {
          const email = emailByUserId.get(member.value) || '';
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            unresolvedMemberships += 1;
            continue;
          }
          rows.push(['membership', 'add', email, '', group.displayName]);
        }
      }

      if (unresolvedMemberships > 0) {
        throw new Error(`Membership export was blocked because ${unresolvedMemberships} member identit${unresolvedMemberships === 1 ? 'y is' : 'ies are'} unresolved. No partial CSV was created.`);
      }
      downloadCsv('omnikit-current-group-memberships.csv', rows);
      showExportNotice(`Group membership export started (${groups.length} groups).`);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to export group memberships'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setExportingMemberships(false);
    }
  }

  function showExportNotice(message: string) {
    setExportNotice(message);
    window.setTimeout(() => setExportNotice(''), 4000);
  }

  async function loadUsersForAssignment() {
    const requestKey = connectionKey;
    setLoadingAssignUsers(true);
    setError('');
    setAssignUsers([]);
    setAssignUsersComplete(false);
    setSelectedAssignUserIds(new Set());
    setAssignResults([]);
    try {
      const res = await listAllUsers(connection.baseUrl, connection.apiKey, { pageSize: 100, maxPages: 200 });
      if (!isActiveConnectionRequest(requestKey)) return;
      if (res.error || res.truncated) throw new Error(incompleteCollectionMessage('User', res));
      const allUsers = (res.Resources || []).map((user: Record<string, unknown>) => ({
        id: user.id as string,
        userName: user.userName as string,
        displayName: (user.displayName as string) || '',
        active: user.active as boolean,
        groups: (user.groups as OmniUser['groups']) || [],
      }));
      setAssignUsers(allUsers);
      setAssignUsersComplete(true);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to load users for assignment'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoadingAssignUsers(false);
    }
  }

  function toggleAssignmentUser(userId: string) {
    setAssignResults([]);
    setSelectedAssignUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleVisibleAssignmentUsers() {
    setAssignResults([]);
    const visibleIds = filteredAssignUsers.map((user) => user.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedAssignUserIds.has(id));
    setSelectedAssignUserIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  async function handleAssignSelectedUsersToGroup() {
    const requestKey = connectionKey;
    const targetGroup = groups.find((group) => group.id === bulkAssignGroupId);
    const selectedUsers = assignUsers.filter((user) => selectedAssignUserIds.has(user.id));
    if (!targetGroup || selectedUsers.length === 0) return;
    if (groupLoadState !== 'complete' || !assignUsersComplete) {
      setError('Membership changes require complete group and user collection coverage. Refresh both inventories before continuing.');
      return;
    }

    setAssigningUsers(true);
    setAssignResults([]);
    setError('');

    try {
      const detail = await requireGroupMembershipDetail(targetGroup, requestKey);
      if (!detail) return;
      const existingMemberIds = new Set(detail.members.map((member) => member.value));
      const additions = selectedUsers
        .filter((user) => !existingMemberIds.has(user.id))
        .map((user) => ({ value: user.id, display: user.userName || user.displayName }));

      if (additions.length === 0) {
        setAssignResults([`Skipped: all ${selectedUsers.length} selected users are already in ${targetGroup.displayName}.`]);
        return;
      }

      const updatedGroup = { ...detail, members: [...detail.members, ...additions] };
      const patch = buildGroupMembershipPatch(additions, []);
      if (!patch) return;
      if (!isActiveConnectionRequest(requestKey)) return;
      await patchGroup(connection.baseUrl, connection.apiKey, targetGroup.id, patch);
      if (!isActiveConnectionRequest(requestKey)) return;
      setDetailedGroups((prev) => ({ ...prev, [targetGroup.id]: updatedGroup }));
      setAssignResults([
        `Added ${additions.length} user${additions.length === 1 ? '' : 's'} to ${targetGroup.displayName}.`,
        selectedUsers.length - additions.length > 0
          ? `Skipped ${selectedUsers.length - additions.length} already-existing membership${selectedUsers.length - additions.length === 1 ? '' : 's'}.`
          : '',
      ].filter(Boolean));
      setSelectedAssignUserIds(new Set());
      fetchGroups();
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to assign users to group'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setAssigningUsers(false);
    }
  }

  const filteredAssignUsers = useMemo(() => {
    const term = assignUserSearch.trim().toLowerCase();
    if (!term) return assignUsers;
    return assignUsers.filter((user) =>
      user.userName.toLowerCase().includes(term) ||
      (user.displayName || '').toLowerCase().includes(term),
    );
  }, [assignUsers, assignUserSearch]);

  const selectedAssignUsers = useMemo(
    () => assignUsers.filter((user) => selectedAssignUserIds.has(user.id)),
    [assignUsers, selectedAssignUserIds],
  );

  const filteredGroups = searchFilter
    ? groups.filter((g) => g.displayName.toLowerCase().includes(searchFilter.toLowerCase()))
    : groups;
  const selectedBulkGroup = groups.find((group) => group.id === bulkAssignGroupId);
  const groupCollectionComplete = groupLoadState === 'complete';
  const headerActions = (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={handleDownloadGroupAssignments}
        disabled={groups.length === 0 || exportingMemberships || !groupCollectionComplete}
        title={!groupCollectionComplete && groups.length > 0 ? 'Export requires complete group collection coverage.' : undefined}
        className="btn-secondary text-sm disabled:opacity-40"
      >
        {exportingMemberships ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {exportingMemberships ? 'Preparing...' : 'Export Memberships'}
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title="Group Management"
          description={`Bulk assign migrated users to Omni groups through SCIM. ${groupLoadState === 'complete' ? `${groups.length} groups found.` : groupLoadState === 'partial' ? `${groups.length} groups loaded with partial coverage.` : 'Group records are not loaded.'}`}
          icon={<Blobby mood="groups" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
          actions={headerActions}
        />
      ) : (
        <div className="card p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Groups</div>
            <p className="text-xs text-content-secondary mt-0.5">
              Review and edit individual groups here, or use Bulk Import for a complete identity migration file.
            </p>
          </div>
          {headerActions}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {exportNotice && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-card">
          {exportNotice} If you are using the in-app preview, the file may appear in the host browser downloads instead of inside the preview pane.
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Step 1</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Choose a group</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Search and open the group first so membership changes have a clear target.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Step 2</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Review members</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Expand the group to confirm who already belongs before adding or removing users.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Step 3</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Apply updates</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Add selected users directly, or use Bulk Import for validated add/remove migration actions.</p>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Choose and review a group</div>
            <p className="text-xs text-content-secondary mt-0.5">
              Select a target group for bulk assignment, or open a group below to review current members.
            </p>
          </div>
          {selectedBulkGroup && (
            <div className="rounded-chip border border-omni-200 bg-omni-50 px-3 py-1 text-xs font-medium text-omni-800">
              Selected: {selectedBulkGroup.displayName}
            </div>
          )}
        </div>
        <div>
          <SearchInput value={searchFilter} onChange={setSearchFilter} placeholder="Filter groups..." />
        </div>
      </div>

      <fieldset disabled={assigningUsers || !groupCollectionComplete} className="card min-w-0 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Add multiple users to a group</div>
            <p className="text-xs text-content-secondary mt-0.5">
              {selectedBulkGroup
                ? `Bulk add users to ${selectedBulkGroup.displayName}. Use Bulk Import for larger migration files or remove actions.`
                : 'Choose a target group, then load users and add selected people to that group.'}
            </p>
          </div>
          <button
            type="button"
            onClick={loadUsersForAssignment}
            disabled={loadingAssignUsers || !selectedBulkGroup}
            className="btn-secondary text-sm disabled:opacity-40"
          >
            {loadingAssignUsers ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {assignUsers.length > 0 ? 'Refresh Users' : 'Load Users'}
          </button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(220px,320px)_minmax(0,1fr)_auto] lg:items-center">
          <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-content-secondary">Target group</div>
            <select
              value={bulkAssignGroupId}
              onChange={(event) => {
                setBulkAssignGroupId(event.target.value);
                setAssignResults([]);
              }}
              className="mt-1 w-full bg-transparent text-sm font-semibold text-content-primary outline-none"
            >
              <option value="">Select a group...</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{group.displayName}</option>
              ))}
            </select>
          </div>
          <SearchInput value={assignUserSearch} onChange={setAssignUserSearch} placeholder="Filter users by email or name..." />
          <button
            type="button"
            onClick={toggleVisibleAssignmentUsers}
            disabled={filteredAssignUsers.length === 0 || !selectedBulkGroup}
            className="btn-secondary text-sm whitespace-nowrap disabled:opacity-40"
          >
            {filteredAssignUsers.length > 0 && filteredAssignUsers.every((user) => selectedAssignUserIds.has(user.id))
              ? 'Clear Visible'
              : `Select Visible (${filteredAssignUsers.length})`}
          </button>
        </div>

        {!selectedBulkGroup ? (
          <div className="rounded-card border border-border bg-surface-secondary p-4 text-sm text-content-secondary">
            Select a target group before assigning users.
          </div>
        ) : assignUsers.length === 0 ? (
          <div className="rounded-card border border-border bg-surface-secondary p-4 text-sm text-content-secondary">
            Load users to assign group membership from the UI.
          </div>
        ) : (
          <div className="rounded-card border border-border overflow-hidden">
            <div className="max-h-52 overflow-y-auto divide-y divide-border/50 bg-white">
              {filteredAssignUsers.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-content-secondary">No users match this filter.</div>
              ) : (
                filteredAssignUsers.map((user) => {
                  const selected = selectedAssignUserIds.has(user.id);
                  return (
                    <label key={user.id} className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-all ${selected ? selectedRowClass : unselectedRowClass}`}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleAssignmentUser(user.id)}
                        className="accent-omni-700"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-content-primary truncate">{user.userName}</div>
                        <div className="text-xs text-content-secondary truncate">{user.displayName || 'No display name'}</div>
                      </div>
                      {selected && (
                        <span className={selectedBadgeClass}>
                          <CheckCircle2 size={12} />
                          Selected
                        </span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-content-secondary">
            {selectedAssignUsers.length} selected user{selectedAssignUsers.length === 1 ? '' : 's'}.
          </div>
          <button
            type="button"
            onClick={handleAssignSelectedUsersToGroup}
            disabled={!bulkAssignGroupId || selectedAssignUsers.length === 0 || assigningUsers}
            className="btn-primary text-sm disabled:opacity-40"
          >
            {assigningUsers ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {selectedBulkGroup ? `Add Selected to ${selectedBulkGroup.displayName}` : 'Add Selected to Group'}
          </button>
        </div>

        {assignResults.length > 0 && (
          <div className="rounded-card border border-green-200 bg-green-50 divide-y divide-green-100">
            {assignResults.map((message, index) => (
              <div key={`${message}-${index}`} className="px-3 py-2 text-xs text-green-800">
                {message}
              </div>
            ))}
          </div>
        )}
      </fieldset>

      {loading ? (
        <WorkflowStatusScene
          variant="bulk-upload"
          title="Loading groups"
          detail="Fetching groups and membership counts before bulk assignment."
          statusLabel="Loading"
          compact
        />
      ) : (
        <div className="space-y-3">
          {groupLoadState === 'not_loaded' ? (
            <div className="card p-8 text-center">
              <div className="text-sm font-semibold text-content-primary">Group records were not loaded</div>
              <p className="text-xs text-content-secondary mt-1">Review the request error and try again. An unavailable read is not evidence that no groups exist.</p>
            </div>
          ) : groups.length === 0 && groupLoadState === 'complete' ? (
            <div className="card p-8 text-center">
              <div className="text-sm font-semibold text-content-primary">No groups found</div>
              <p className="text-xs text-content-secondary mt-1">
                Groups must exist before bulk assignments can run. Create groups in Omni, then return here to map migrated users.
              </p>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="text-sm font-semibold text-content-primary">No loaded groups match this filter</div>
              <p className="text-xs text-content-secondary mt-1">
                Adjust the filter or review the collection coverage above before drawing a group-inventory conclusion.
              </p>
            </div>
          ) : filteredGroups.map((group) => {
            const isExpanded = expandedIds.has(group.id);
            const detail = detailedGroups[group.id];
            const members = detail?.members ?? group.members;
            const memberEvidence = membershipEvidence[group.id] || 'unknown';
            const hasAvailableMembers = memberEvidence === 'available' && Array.isArray(members);

            return (
              <div key={group.id} className={`relative card p-0 overflow-hidden transition-all ${bulkAssignGroupId === group.id ? selectedCardClass : unselectedCardClass}`}>
                {bulkAssignGroupId === group.id && <div className="absolute left-0 top-0 h-full w-1 rounded-l-[8px] bg-omni-500" />}
                <button
                  type="button"
                  onClick={() => toggleExpand(group.id)}
                  aria-pressed={bulkAssignGroupId === group.id}
                  aria-expanded={isExpanded}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-secondary transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className="text-sm font-medium text-content-primary">{group.displayName}</span>
                    <span className="text-xs text-content-secondary bg-surface-secondary px-2 py-0.5 rounded-chip">
                      {hasAvailableMembers
                        ? `${members.length} member${members.length === 1 ? '' : 's'}`
                        : memberEvidence === 'failed'
                          ? 'Membership unavailable'
                          : 'Membership not inspected'}
                    </span>
                    {bulkAssignGroupId === group.id && (
                      <span className={selectedBadgeClass}>
                        <CheckCircle2 size={12} />
                        Selected
                      </span>
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border">
                    {loadingDetailIds.has(group.id) ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 size={16} className="text-omni-500 animate-spin" />
                      </div>
                    ) : memberEvidence === 'failed' ? (
                      <div className="px-4 py-4 text-sm text-content-secondary">Membership detail is unavailable. No zero-member claim is made.</div>
                    ) : !hasAvailableMembers ? (
                      <div className="px-4 py-4 text-sm text-content-secondary">Membership detail has not been verified. No member count is claimed.</div>
                    ) : (
                      <>
                        <div className="px-4 py-2 bg-surface-secondary flex items-center justify-between">
                          <span className="text-xs font-medium text-content-secondary uppercase tracking-wider">Members</span>
                          <button
                            type="button"
                            aria-label={`Add member to ${group.displayName}`}
                            onClick={() => setAddMemberGroup(group)}
                            disabled={!groupCollectionComplete}
                            className="text-xs text-omni-700 hover:text-omni-500 font-medium flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <UserPlus size={12} />
                            Add Member
                          </button>
                        </div>
                        {members.length === 0 ? (
                          <div className="px-4 py-4 text-sm text-content-secondary">No members in this group.</div>
                        ) : (
                          members.map((member) => (
                            <div
                              key={member.value}
                              className="px-4 py-2 border-t border-border/50 flex items-center justify-between hover:bg-surface-secondary transition-colors"
                            >
                              <div className="text-sm">
                                <span className="text-content-primary">{member.display || member.value}</span>
                                {member.display && (
                                  <span className="text-xs text-content-secondary font-mono ml-2">{member.value}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                aria-label={`Remove ${member.display || member.value} from ${group.displayName}`}
                                onClick={() =>
                                  setRemoveMember({
                                    group,
                                    memberId: member.value,
                                    memberName: member.display || member.value,
                                  })
                                }
                                disabled={!groupCollectionComplete}
                                className="p-1 text-content-secondary hover:text-error hover:bg-red-50 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <UserMinus size={14} />
                              </button>
                            </div>
                          ))
                        )}
                      </>
                    )}
                    <div className="border-t border-border/50 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => inspectAccessPosture(group.id)}
                        disabled={loadingAccessPostureId === group.id || !connection.instanceId}
                        className="btn-secondary text-xs disabled:opacity-40"
                      >
                        {loadingAccessPostureId === group.id ? <Loader2 size={12} className="animate-spin" /> : null}
                        Inspect model-role assignments
                      </button>
                      {accessPostureErrors[group.id] && <div role="alert" className="mt-2 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{accessPostureErrors[group.id]}</div>}
                      {accessPostureByGroup[group.id] && <AccessPostureEvidence posture={accessPostureByGroup[group.id]} />}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddMemberModal
        open={!!addMemberGroup}
        groupName={addMemberGroup?.displayName || ''}
        onClose={() => setAddMemberGroup(null)}
        onAdd={handleAddMember}
      />

      <ConfirmDialog
        open={!!removeMember}
        title="Remove Member"
        message={`Remove "${removeMember?.memberName}" from "${removeMember?.group.displayName}"?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={handleRemoveMember}
        onCancel={() => setRemoveMember(null)}
      />
    </div>
  );
}
