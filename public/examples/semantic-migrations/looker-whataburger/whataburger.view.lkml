view: daily_grill_report {
  sql_table_name: analytics.daily_grill_report ;;
  dimension: order_id { primary_key: yes type: string sql: ${TABLE}.order_id ;; }
  dimension_group: business_date { type: time timeframes: [date, week, month] sql: ${TABLE}.business_date ;; }
  dimension: store_number { type: string sql: ${TABLE}.store_number ;; }
  dimension: order_channel { type: string sql: ${TABLE}.order_channel ;; }
  dimension: daypart { type: string sql: ${TABLE}.daypart ;; }
  dimension: gross_sales { type: number sql: ${TABLE}.gross_sales ;; }
  dimension: discounts { type: number sql: ${TABLE}.discounts ;; }
  dimension: net_sales { type: number sql: ${TABLE}.net_sales ;; }
  dimension: order_count { type: number sql: ${TABLE}.order_count ;; }
  dimension: units_sold { type: number sql: ${TABLE}.units_sold ;; }
  dimension: add_on_revenue { type: number sql: ${TABLE}.add_on_revenue ;; }
  measure: total_revenue { type: sum sql: ${net_sales} ;; }
  measure: orders { type: count_distinct sql: ${order_id} ;; }
  measure: average_bag_size { type: number sql: ${total_revenue} / NULLIF(${orders}, 0) ;; }
  measure: attach_rate { type: number sql: SUM(${add_on_revenue}) / NULLIF(SUM(${net_sales}), 0) ;; }
  measure: discount_rate { type: number sql: SUM(${discounts}) / NULLIF(SUM(${gross_sales}), 0) ;; }
}

view: whataburger_locations {
  sql_table_name: analytics.whataburger_locations ;;
  dimension: store_number { primary_key: yes type: string sql: ${TABLE}.store_number ;; }
  dimension: location_name { type: string sql: ${TABLE}.location_name ;; }
  dimension: city { type: string sql: ${TABLE}.city ;; }
  dimension: state { type: string sql: ${TABLE}.state ;; }
  dimension: territory { type: string sql: ${TABLE}.territory ;; }
  dimension: region { type: string sql: ${TABLE}.region ;; }
  measure: location_count { type: count_distinct sql: ${store_number} ;; }
}

view: bag_tickets {
  sql_table_name: analytics.bag_tickets ;;
  dimension: order_id { primary_key: yes type: string sql: ${TABLE}.order_id ;; }
  dimension: store_number { type: string sql: ${TABLE}.store_number ;; }
  dimension_group: business_date { type: time timeframes: [date, week, month] sql: ${TABLE}.business_date ;; }
  dimension: item_count { type: number sql: ${TABLE}.item_count ;; }
  dimension: ticket_total { type: number sql: ${TABLE}.ticket_total ;; }
  dimension: bag_size { type: number sql: ${TABLE}.bag_size ;; }
  dimension: order_channel { type: string sql: ${TABLE}.order_channel ;; }
  measure: items_per_bag { type: number sql: SUM(${item_count}) / NULLIF(COUNT(DISTINCT ${order_id}), 0) ;; }
}

view: grill_slips {
  sql_table_name: analytics.grill_slips ;;
  dimension: order_id { type: string sql: ${TABLE}.order_id ;; }
  dimension: menu_item_id { type: string sql: ${TABLE}.menu_item_id ;; }
  dimension: category { type: string sql: ${TABLE}.category ;; }
  dimension: quantity { type: number sql: ${TABLE}.quantity ;; }
  dimension: line_revenue { type: number sql: ${TABLE}.line_revenue ;; }
  dimension: station_name { type: string sql: ${TABLE}.station_name ;; }
  dimension: prep_seconds { type: number sql: ${TABLE}.prep_seconds ;; }
  measure: units_sold { type: sum sql: ${quantity} ;; }
}

view: menu_board {
  sql_table_name: analytics.menu_board ;;
  dimension: menu_item_id { primary_key: yes type: string sql: ${TABLE}.menu_item_id ;; }
  dimension: item_name { type: string sql: ${TABLE}.item_name ;; }
  dimension: category { type: string sql: ${TABLE}.category ;; }
  dimension: menu_group { type: string sql: ${TABLE}.menu_group ;; }
  dimension: list_price { type: number sql: ${TABLE}.list_price ;; }
  dimension: active_flag { type: yesno sql: ${TABLE}.active_flag = 'Y' ;; }
  measure: active_menu_items { type: count_distinct sql: CASE WHEN ${active_flag} THEN ${menu_item_id} END ;; }
}

view: menu_item_pnl {
  sql_table_name: analytics.menu_item_pnl ;;
  dimension: menu_item_id { primary_key: yes type: string sql: ${TABLE}.menu_item_id ;; }
  dimension: category { type: string sql: ${TABLE}.category ;; }
  dimension: units_sold { type: number sql: ${TABLE}.units_sold ;; }
  dimension: gross_revenue { type: number sql: ${TABLE}.gross_revenue ;; }
  dimension: discounts { type: number sql: ${TABLE}.discounts ;; }
  dimension: net_revenue { type: number sql: ${TABLE}.net_revenue ;; }
  dimension: food_cost { type: number sql: ${TABLE}.food_cost ;; }
  dimension: gross_margin { type: number sql: ${TABLE}.gross_margin ;; }
  measure: total_gross_margin { type: sum sql: ${gross_margin} ;; }
  measure: margin_pct { type: number sql: SUM(${gross_margin}) / NULLIF(SUM(${net_revenue}), 0) ;; }
  measure: total_food_cost { type: sum sql: ${food_cost} ;; }
}
