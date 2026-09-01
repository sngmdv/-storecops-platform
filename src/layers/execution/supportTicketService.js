'use strict';

/**
 * Support Ticket Service
 *
 * Handles customer support tickets with:
 * - Ticket creation, assignment, and resolution
 * - Priority and status management
 * - Internal notes and responses
 * - SLA tracking
 * - Integration with notification service
 */

const TICKET_STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed',];
const TICKET_PRIORITIES = ['low', 'medium', 'high', 'critical',];
const TICKET_CATEGORIES = [
  'billing',
  'technical',
  'account',
  'feature_request',
  'bug_report',
  'integration',
  'other',
];

function createSupportTicketService({ store, notificationService, },) {
  return {
    TICKET_STATUSES,
    TICKET_PRIORITIES,
    TICKET_CATEGORIES,

    /**
     * Create a new support ticket.
     */
    async createTicket({ store_id, customer_id, subject, description, category, priority, metadata, },) {
      if (!store_id) throw new Error('store_id is required',);
      if (!subject) throw new Error('subject is required',);
      if (!description) throw new Error('description is required',);

      const ticket = await store.supportTickets?.insert({
        store_id,
        customer_id,
        subject,
        description,
        category: category || 'other',
        priority: priority || 'medium',
        status: 'open',
        assignee: null,
        responses: [],
        internal_notes: [],
        tags: [],
        sla: {
          created_at: new Date().toISOString(),
          first_response_at: null,
          resolved_at: null,
          response_time_ms: null,
          resolution_time_ms: null,
        },
        metadata: metadata || {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },);

      // Notify admin of new ticket
      if (notificationService) {
        await notificationService.send(store_id, {
          type: 'support_ticket',
          title: 'New Support Ticket',
          message: `${subject} (${priority || 'medium'} priority)`,
          icon: '🎫',
          severity: priority === 'critical' ? 'critical' : 'info',
          category: 'support',
        },);
      }

      return ticket;
    },

    /**
     * Get a ticket by ID.
     */
    async getTicket(ticket_id,) {
      if (!store.supportTickets) return null;
      return store.supportTickets.findById(ticket_id,);
    },

    /**
     * Get all tickets for a store with optional filters.
     */
    async getTickets(store_id, filters = {},) {
      if (!store.supportTickets) return [];

      let tickets = await store.supportTickets.find({ store_id, },);

      if (filters.status) {
        tickets = tickets.filter((t,) => t.status === filters.status,);
      }
      if (filters.priority) {
        tickets = tickets.filter((t,) => t.priority === filters.priority,);
      }
      if (filters.category) {
        tickets = tickets.filter((t,) => t.category === filters.category,);
      }
      if (filters.assignee) {
        tickets = tickets.filter((t,) => t.assignee === filters.assignee,);
      }

      // Sort by priority (critical > high > medium > low) then by date
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, };
      tickets.sort((a, b,) => {
        const pDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
        if (pDiff !== 0) return pDiff;
        return new Date(b.created_at,) - new Date(a.created_at,);
      },);

      return tickets;
    },

    /**
     * Update ticket status.
     */
    async updateStatus(ticket_id, status, assignee,) {
      if (!TICKET_STATUSES.includes(status,)) {
        throw new Error(`Invalid status: ${status}`,);
      }

      const ticket = await this.getTicket(ticket_id,);
      if (!ticket) throw new Error('Ticket not found',);

      const patch = {
        status,
        updated_at: new Date().toISOString(),
      };

      if (assignee) {
        patch.assignee = assignee;
      }

      // Track SLA milestones
      if (status === 'in_progress' && !ticket.sla.first_response_at) {
        patch.sla = {
          ...ticket.sla,
          first_response_at: new Date().toISOString(),
          response_time_ms: Date.now() - new Date(ticket.sla.created_at,).getTime(),
        };
      }

      if (status === 'resolved' || status === 'closed') {
        patch.sla = {
          ...ticket.sla,
          resolved_at: new Date().toISOString(),
          resolution_time_ms: Date.now() - new Date(ticket.sla.created_at,).getTime(),
        };
      }

      return store.supportTickets.update(ticket_id, patch,);
    },

    /**
     * Add a response to a ticket.
     */
    async addResponse(ticket_id, { author, message, is_internal, },) {
      const ticket = await this.getTicket(ticket_id,);
      if (!ticket) throw new Error('Ticket not found',);

      const response = {
        id: `resp_${Date.now()}`,
        author,
        message,
        is_internal: is_internal || false,
        created_at: new Date().toISOString(),
      };

      const responses = is_internal
        ? [...(ticket.internal_notes || []), response,]
        : [...ticket.responses, response,];

      const patch = is_internal
        ? { internal_notes: responses, updated_at: new Date().toISOString(), }
        : { responses, updated_at: new Date().toISOString(), };

      // Auto-update status to in_progress if first response
      if (!is_internal && ticket.status === 'open') {
        patch.status = 'in_progress';
        patch.sla = {
          ...ticket.sla,
          first_response_at: new Date().toISOString(),
          response_time_ms: Date.now() - new Date(ticket.sla.created_at,).getTime(),
        };
      }

      return store.supportTickets.update(ticket_id, patch,);
    },

    /**
     * Add tags to a ticket.
     */
    async addTags(ticket_id, tags,) {
      const ticket = await this.getTicket(ticket_id,);
      if (!ticket) throw new Error('Ticket not found',);

      const existingTags = new Set(ticket.tags || [],);
      for (const tag of tags) existingTags.add(tag,);

      return store.supportTickets.update(ticket_id, {
        tags: [...existingTags,],
        updated_at: new Date().toISOString(),
      },);
    },

    /**
     * Get ticket statistics for a store.
     */
    async getStats(store_id,) {
      const tickets = await this.getTickets(store_id,);

      const stats = {
        total: tickets.length,
        open: tickets.filter((t,) => t.status === 'open',).length,
        in_progress: tickets.filter((t,) => t.status === 'in_progress',).length,
        waiting: tickets.filter((t,) => t.status === 'waiting_customer',).length,
        resolved: tickets.filter((t,) => t.status === 'resolved',).length,
        closed: tickets.filter((t,) => t.status === 'closed',).length,
        by_priority: {
          critical: tickets.filter((t,) => t.priority === 'critical',).length,
          high: tickets.filter((t,) => t.priority === 'high',).length,
          medium: tickets.filter((t,) => t.priority === 'medium',).length,
          low: tickets.filter((t,) => t.priority === 'low',).length,
        },
        by_category: {},
        avg_response_time_ms: 0,
        avg_resolution_time_ms: 0,
      };

      // Calculate category breakdown
      for (const category of TICKET_CATEGORIES) {
        stats.by_category[category] = tickets.filter((t,) => t.category === category,).length;
      }

      // Calculate average times
      const respondedTickets = tickets.filter((t,) => t.sla?.response_time_ms,);
      if (respondedTickets.length > 0) {
        stats.avg_response_time_ms = Math.round(
          respondedTickets.reduce((sum, t,) => sum + t.sla.response_time_ms, 0,) / respondedTickets.length,
        );
      }

      const resolvedTickets = tickets.filter((t,) => t.sla?.resolution_time_ms,);
      if (resolvedTickets.length > 0) {
        stats.avg_resolution_time_ms = Math.round(
          resolvedTickets.reduce((sum, t,) => sum + t.sla.resolution_time_ms, 0,) / resolvedTickets.length,
        );
      }

      return stats;
    },

    /**
     * Search tickets by subject or description.
     */
    async searchTickets(store_id, query,) {
      if (!store.supportTickets) return [];

      const allTickets = await store.supportTickets.find({ store_id, },);
      const lowerQuery = query.toLowerCase();

      return allTickets.filter(
        (t,) =>
          t.subject.toLowerCase().includes(lowerQuery,) ||
          t.description.toLowerCase().includes(lowerQuery,) ||
          (t.tags || []).some((tag,) => tag.toLowerCase().includes(lowerQuery,),),
      );
    },
  };
}

module.exports = { createSupportTicketService, TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES, };
