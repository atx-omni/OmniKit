import { Navigate, useLocation } from 'react-router';

interface ForcedSearchParam {
  name: string;
  value: string;
}

interface QueryPreservingRedirectProps {
  to: string;
  forceSearchParam?: ForcedSearchParam;
}

function decodedSearchParamName(segment: string): string {
  const separatorIndex = segment.indexOf('=');
  const rawName = separatorIndex === -1 ? segment : segment.slice(0, separatorIndex);
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

function forceSingleSearchParam(
  search: string,
  forcedParam: ForcedSearchParam,
): string {
  const rawSearch = search.startsWith('?') ? search.slice(1) : search;
  const segments = rawSearch ? rawSearch.split('&') : [];
  const retainedSegments = segments.filter(
    (segment) => decodedSearchParamName(segment) !== forcedParam.name,
  );
  retainedSegments.push(
    `${encodeURIComponent(forcedParam.name)}=${encodeURIComponent(forcedParam.value)}`,
  );
  return `?${retainedSegments.join('&')}`;
}

export function QueryPreservingRedirect({
  to,
  forceSearchParam,
}: QueryPreservingRedirectProps) {
  const location = useLocation();
  const search = forceSearchParam
    ? forceSingleSearchParam(location.search, forceSearchParam)
    : location.search;

  return (
    <Navigate
      replace
      to={{
        pathname: to,
        search,
        hash: location.hash,
      }}
    />
  );
}
