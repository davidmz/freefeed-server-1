import { escape as urlEscape } from 'querystring';
import _ from 'lodash';
import compose from 'koa-compose';

import { dbAdapter } from '../../../models';
import { load as configLoader } from '../../../../config/config';
import { serializePostsCollection, serializePost, serializeComment, serializeAttachment } from '../../../serializers/v2/post';
import { monitored, authRequired, targetUserRequired } from '../../middlewares';
import { userSerializerFunction } from '../../../serializers/v2/user';


export const ORD_UPDATED = 'bumped';
export const ORD_CREATED = 'created';

/**
 * "Only friends" homefeed mode
 *
 * Displays posts from Posts/Directs feeds subscribed to by viewer.
 */
export const HOMEFEED_MODE_FRIENDS_ONLY = 'friends-only';

/**
 * "Classic" homefeed mode
 *
 * Displays posts from Posts/Directs feeds and propagable posts
 * from Comments/Likes feeds subscribed to by viewer.
 */
export const HOMEFEED_MODE_CLASSIC = 'classic';

/**
 * "All friends activity" homefeed mode
 *
 * Displays posts from Posts/Directs feeds and all (not only propagable) posts
 * from Comments/Likes feeds subscribed to by viewer. Also displays all posts
 * created by users subscribed to by viewer.
 */
export const HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY = 'friends-all-activity';

const config = configLoader();

export const bestOf = compose([
  monitored('timelines.bestof'),
  async (ctx) => {
    const DEFAULT_LIMIT = 30;

    const currentUserId = ctx.state.user ? ctx.state.user.id : null;
    const offset = parseInt(ctx.request.query.offset, 10) || 0;
    const limit =  parseInt(ctx.request.query.limit, 10) || DEFAULT_LIMIT;

    const foundPosts = await dbAdapter.bestPosts(ctx.state.user, offset, limit + 1);
    const isLastPage = foundPosts.length <= limit;

    if (!isLastPage) {
      foundPosts.length = limit;
    }

    const postsObjects = dbAdapter.initRawPosts(foundPosts, { currentUser: currentUserId });
    const postsCollectionJson = await serializePostsCollection(postsObjects, currentUserId);

    ctx.body = { ...postsCollectionJson, isLastPage };
  },
]);

/**
 * Name for data dog
 *
 * @param {string} feedName
 * @returns {string}
 */
function monitoredFeedName(feedName) {
  switch (feedName) {
    case 'RiverOfNews':   return 'home';
    case 'MyDiscussions': return 'my-discussions';
    default:              return feedName.toLowerCase();
  }
}

export const ownTimeline = (feedName, params = {}) => compose([
  authRequired(),
  monitored(`timelines.${monitoredFeedName(feedName)}-v2`),
  async (ctx) => {
    const { user } = ctx.state;
    const timeline = await dbAdapter.getUserNamedFeed(user.id, feedName);
    ctx.body = await genericTimeline(timeline, user.id, { ...params, ...getCommonParams(ctx) });
  },
]);

export const userTimeline = (feedName) => compose([
  targetUserRequired(),
  monitored(`timelines.${feedName.toLowerCase()}-v2`),
  async (ctx) => {
    const { targetUser, user: viewer } = ctx.state;
    const timeline = await dbAdapter.getUserNamedFeed(targetUser.id, feedName);
    ctx.body = await genericTimeline(timeline, viewer ? viewer.id : null, {
      withoutDirects: (feedName !== 'Posts'),
      ...getCommonParams(ctx),
    });
  },
]);

export const metatags = compose([
  monitored(`timelines-metatags`),
  async (ctx) => {
    const { username } = ctx.params;
    const targetUser = await dbAdapter.getFeedOwnerByUsername(username);

    if (!targetUser || !targetUser.isActive) {
      ctx.body = '';
      return;
    }

    const rssURL = `${config.host}/v2/timelines-rss/${urlEscape(targetUser.username)}`;
    const rssTitle = targetUser.isUser() ? `Posts of ${targetUser.username}` : `Posts in group ${targetUser.username}`;
    ctx.body = `<link rel="alternate" type="application/rss+xml" title="${_.escape(rssTitle)}" href="${_.escape(rssURL)}" data-react-helmet="true">`;
  },
]);

/**
 * Fetch common timelines parameters from the request
 *
 * @param {object} ctx                                - request context object
 * @param {string} [ctx.request.query.limit]          - Number of posts returned (default: 30)
 * @param {string} [ctx.request.query.offset]         - Number of posts to skip (default: 0)
 * @param {string} [ctx.request.query.sort]           - Sort mode ('created' or 'updated')
 * @param {string} [ctx.request.query.with-my-posts]  - For filter/discussions only: return viewer's own
 *                                                      posts even without his likes or comments (default: no)
 * @param {string} [ctx.request.query.homefeed-mode]  - For RiverOfNews only: homefeed selection mode
 * @param {string} [ctx.request.query.created-before] - Show only posts created before this datetime (ISO 8601)
 * @param {string} [ctx.request.query.created-after]  - Show only posts created after this datetime (ISO 8601)
 * @param {string} defaultSort                        - Default sort mode
 * @return {object}                                   - Object with the following sructure:
 *                                                      { limit:number, offset:number, sort:string, withMyPosts:boolean, hiddenCommentTypes: array }
 */
function getCommonParams(ctx, defaultSort = ORD_UPDATED) {
  const { query } = ctx.request;
  const viewer = ctx.state.user;

  let limit = parseInt(query.limit, 10);

  if (isNaN(limit) || limit < 0 || limit > 120) {
    limit = 30;
  }

  let offset = parseInt(query.offset, 10);

  if (isNaN(offset) || offset < 0) {
    offset = 0;
  }

  let createdBefore = new Date(query['created-before']);

  if (isNaN(createdBefore)) {
    createdBefore = null;
  }

  let createdAfter = new Date(query['created-after']);

  if (isNaN(createdAfter)) {
    createdAfter = null;
  }

  const withMyPosts = ['yes', 'true', '1', 'on'].includes((query['with-my-posts'] || '').toLowerCase());
  const sort = (query.sort === ORD_CREATED || query.sort === ORD_UPDATED) ? query.sort : defaultSort;
  const homefeedMode = [
    HOMEFEED_MODE_FRIENDS_ONLY,
    HOMEFEED_MODE_CLASSIC,
    HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY,
  ].includes(query['homefeed-mode']) ? query['homefeed-mode'] : HOMEFEED_MODE_CLASSIC;
  const hiddenCommentTypes = viewer ? viewer.getHiddenCommentTypes() : [];
  return { limit, offset, sort, homefeedMode, withMyPosts, hiddenCommentTypes, createdBefore, createdAfter };
}

async function genericTimeline(timeline, viewerId = null, params = {}) {
  params = {
    limit:              30,
    offset:             0,
    sort:               ORD_UPDATED,
    homefeedMode:       HOMEFEED_MODE_CLASSIC,
    withLocalBumps:     false,  // consider viewer local bumps (for RiverOfNews)
    withoutDirects:     false,  // do not show direct messages (for Likes and Comments)
    withMyPosts:        false,  // show viewer's own posts even without his likes or comments (for MyDiscussions)
    hiddenCommentTypes: [],     // dont show hidden/deleted comments of these hide_type's
    createdBefore:      null,
    createdAfter:       null,
    ...params,
  };

  params.withLocalBumps = params.withLocalBumps && !!viewerId && params.sort === ORD_UPDATED;
  params.withMyPosts = params.withMyPosts && timeline.name === 'MyDiscussions';

  const allUserIds = new Set();
  const allPosts = [];
  const allComments = [];
  const allAttachments = [];
  const allDestinations = [];
  const allSubscribers = [];

  const { intId: hidesFeedId } = viewerId ? await dbAdapter.getUserNamedFeed(viewerId, 'Hides') : { intId: 0 };

  const timelineIds = [timeline.intId];
  const activityFeedIds = [];
  const authorsIds = [];

  if (params.withMyPosts) {
    authorsIds.push(viewerId);
  }

  const owner = await timeline.getUser();
  let canViewUser = true;

  if (timeline.name === 'MyDiscussions') {
    const srcIds = await Promise.all([
      owner.getCommentsTimelineIntId(),
      owner.getLikesTimelineIntId(),
    ]);
    timelineIds.length = 0;
    timelineIds.push(...srcIds);
  } else if (['Posts', 'Comments', 'Likes'].includes(timeline.name)) {
    // Checking access rights for viewer
    if (!viewerId) {
      canViewUser = (owner.isProtected === '0');
    } else if (viewerId !== owner.id) {
      if (owner.isPrivate === '1') {
        const subscribers = await dbAdapter.getUserSubscribersIds(owner.id);
        canViewUser = subscribers.includes(viewerId);
      }

      if (canViewUser) {
        // Viewer cannot see feeds of users in ban relations with him
        const banIds = await dbAdapter.getUsersBansOrWasBannedBy(viewerId);
        canViewUser = !banIds.includes(owner.id);
      }
    }
  } else if (timeline.name === 'RiverOfNews' && config.dynamicRiverOfNews) {
    const { destinations, activities } = await dbAdapter.getSubscriprionsIntIds(viewerId);
    timelineIds.length = 0;
    timelineIds.push(...destinations);

    if (params.homefeedMode === HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY) {
      timelineIds.push(...activities);
      const friendsIds = await dbAdapter.getUserFriendIds(viewerId);
      authorsIds.push(...friendsIds);

      if (!authorsIds.includes(viewerId)) {
        authorsIds.push(viewerId);
      }
    } else if (params.homefeedMode === HOMEFEED_MODE_CLASSIC) {
      activityFeedIds.push(...activities);
    }
  }

  const postsIds = canViewUser ?
    await dbAdapter.getTimelinePostsIds(timeline.name, timelineIds, viewerId, { ...params, authorsIds, activityFeedIds, limit: params.limit + 1 }) :
    [];

  const isLastPage = postsIds.length <= params.limit;

  if (!isLastPage) {
    postsIds.length = params.limit;
  }

  const postsWithStuff = await dbAdapter.getPostsWithStuffByIds(postsIds, viewerId, params);

  for (const { post, destinations, attachments, comments, likes, omittedComments, omittedLikes } of postsWithStuff) {
    const sPost = {
      ...serializePost(post),
      postedTo:    destinations.map((d) => d.id),
      comments:    comments.map((c) => c.id),
      attachments: attachments.map((a) => a.id),
      likes,
      omittedComments,
      omittedLikes,
    };

    if (post.feedIntIds.includes(hidesFeedId)) {
      sPost.isHidden = true; // present only if true
    }

    allPosts.push(sPost);
    allDestinations.push(...destinations);
    allSubscribers.push(..._.map(destinations, 'user'));
    allComments.push(...comments.map(serializeComment));
    allAttachments.push(...attachments.map(serializeAttachment));

    allUserIds.add(sPost.createdBy);
    likes.forEach((l) => allUserIds.add(l));
    comments.forEach((c) => allUserIds.add(c.userId));
    destinations.forEach((d) => allUserIds.add(d.user));
  }

  const timelines = _.pick(timeline, ['id', 'name']);
  timelines.user = timeline.userId;
  timelines.posts = postsIds;
  timelines.subscribers = canViewUser ? await dbAdapter.getTimelineSubscribersIds(timeline.id) : [];
  allSubscribers.push(timeline.userId);
  allSubscribers.push(...timelines.subscribers);
  allSubscribers.forEach((s) => allUserIds.add(s));

  const allGroupAdmins = canViewUser ? await dbAdapter.getGroupsAdministratorsIds([...allUserIds], viewerId) : {};
  Object.values(allGroupAdmins).forEach((ids) => ids.forEach((s) => allUserIds.add(s)));

  const [
    allUsersAssoc,
    allStatsAssoc,
  ] = await Promise.all([
    dbAdapter.getUsersByIdsAssoc([...allUserIds]),
    dbAdapter.getUsersStatsAssoc([...allUserIds]),
  ]);

  const uniqSubscribers = _.compact(_.uniq(allSubscribers));

  const serializeUser = userSerializerFunction(allUsersAssoc, allStatsAssoc, allGroupAdmins);

  const users = Object.keys(allUsersAssoc).map(serializeUser).filter((u) => u.type === 'user' || u.id === timeline.userId);
  const subscribers = canViewUser ? uniqSubscribers.map(serializeUser) : [];

  const subscriptions = canViewUser ? _.uniqBy(_.compact(allDestinations), 'id') : [];

  const admins = canViewUser ? (allGroupAdmins[timeline.userId] || []).map(serializeUser) : [];

  return {
    timelines,
    users,
    subscriptions,
    subscribers,
    admins,
    isLastPage,
    posts:       allPosts,
    comments:    _.compact(allComments),
    attachments: _.compact(allAttachments),
  };
}
