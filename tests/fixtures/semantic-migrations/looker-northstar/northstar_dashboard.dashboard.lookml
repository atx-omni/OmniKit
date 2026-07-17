- dashboard: northstar_dashboard
  title: "NorthstarDashboard"
  layout: newspaper
  preferred_viewer: dashboards-next
  filters:
  - name: Business Date
    title: "Business Date"
    type: field_filter
    model: northstar
    explore: daily_grill_report
    field: daily_grill_report.business_date
  elements:
  - name: executive_kpis
    title: "Executive KPIs"
    model: northstar
    explore: daily_grill_report
    type: single_value
    fields: [daily_grill_report.total_revenue, daily_grill_report.orders, daily_grill_report.discount_rate]
    listen:
      Business Date: daily_grill_report.business_date
  - name: weekly_revenue_trend
    title: "Weekly Revenue Trend"
    model: northstar
    explore: daily_grill_report
    type: looker_line
    fields: [daily_grill_report.business_date, daily_grill_report.total_revenue]
    listen:
      Business Date: daily_grill_report.business_date
  - name: location_performance
    title: "Location Performance"
    model: northstar
    explore: daily_grill_report
    type: looker_bar
    fields: [northstar_locations.location_name, northstar_locations.territory, daily_grill_report.total_revenue]
  - name: deals_discounts
    title: "Deals & Discounts"
    model: northstar
    explore: daily_grill_report
    type: table
    fields: [daily_grill_report.business_date, daily_grill_report.discounts, daily_grill_report.discount_rate]
    listen:
      Business Date: daily_grill_report.business_date
  - name: profitability_by_menu_category
    title: "Profitability by Menu Category"
    model: northstar
    explore: daily_grill_report
    type: looker_bar
    fields: [menu_item_pnl.category, menu_item_pnl.net_revenue, menu_item_pnl.margin_pct]
  - name: order_channel_mix
    title: "Order Channel Mix"
    model: northstar
    explore: daily_grill_report
    type: looker_pie
    fields: [daily_grill_report.order_channel, daily_grill_report.total_revenue]
    listen:
      Business Date: daily_grill_report.business_date
